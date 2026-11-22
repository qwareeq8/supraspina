/**
 * Defines the `window.supraspina` IPC bridge contract.
 *
 * This contract is the renderer's single typed surface for backend access. The
 * preload layer publishes an implementation of {@link SupraspinaApi} via
 * `contextBridge`; the main process routes each call to the Python
 * orchestration sidecar (or to Node-native operations such as native dialogs).
 * `renderer/ipc/mock.ts` implements the same interface
 * so screens can be built and previewed without Electron.
 *
 * Route every side effect through this contract. Do not let a screen touch
 * the filesystem or spawn a process directly.
 */

import type { ProjectConfig } from './project-schema'
import type {
  AisGrade,
  CohortRole,
  EnvCreateDirResult,
  EnvReport,
  Job,
  JobStatus,
  LogLevel,
  ProjectRef,
  QcVerdict,
  RunManifest,
  Sex,
  StageBlocker,
  Subject,
  ToolStatus,
} from './types'
import type { ExecutionFallback } from './execution-fallback'
import type {
  ImagesChangedSinceVerdict,
  UnitReuseForecast,
  UnitReuseSummary,
} from './unit-reuse'
import type { StepKey, StepScope } from './steps'
import type {
  MachinePreferencesPatch,
  MachinePreferencesState,
} from './preferences'
import type {
  InputFovListResult,
  InputFovReview,
  InputFovReviewFields,
  ManagedResourceSelector,
  ManagedResourceStatus,
  ManagedResourceStatusResult,
} from './scientific-contracts'

export type {
  InputFovDecision,
  InputFovItem,
  InputFovListResult,
  InputFovReview,
  InputFovReviewFields,
  ManagedResourcePhase,
  ManagedResourceRuntime,
  ManagedResourceSelector,
  ManagedResourceState,
  ManagedResourceStatus,
  ManagedResourceStatusResult,
} from './scientific-contracts'
import type {
  SurfaceRegistrationCancelResult,
  SurfaceRegistrationCheckResult,
  SurfaceRegistrationStatus,
} from './surface-registration'

export type {
  RegistrationHemisphereResult,
  RegistrationOperation,
  RegistrationReference,
  RegistrationSubjectResult,
  SurfaceRegistrationCancelResult,
  SurfaceRegistrationCheckResult,
  SurfaceRegistrationStatus,
} from './surface-registration'
import type {
  AnalysisVariableTable,
  AnyGroupAnalysisResult,
  AnyGroupAnalysisSpec,
  GroupAnalysisCancelResult,
  GroupAnalysisCatalog,
  GroupAnalysisExportRequest,
  GroupAnalysisExportResult,
  GroupAnalysisInputs,
  GroupAnalysisLibrary,
  GroupAnalysisList,
  GroupAnalysisMeasureDetail,
  GroupAnalysisMeasureDetailV2,
  GroupAnalysisStartResult,
  GroupAnalysisStatus,
  GroupAnalysisTermRows,
  AnalysisStageCurrency,
} from './group-analysis'
import type {
  AtlasCatalog,
  AtlasClearLabelsRequest,
  AtlasDownloadCancelResult,
  AtlasDownloadStartResult,
  AtlasDownloadStatus,
  AtlasImportResult,
  AtlasLabelCancelResult,
  AtlasLabelStartRequest,
  AtlasLabelStartResult,
  AtlasLabelStatus,
  AtlasLabelsCleared,
  AtlasLabelsImportResult,
  AtlasRecipeId,
  AtlasSourcesList,
  AtlasSourceUrlKind,
} from './atlas-labeling'
import type {
  BrainAsset,
  BrainAssetReadRequest,
  BrainAssetsReport,
  BrainAssetsRequest,
} from './brain-atlas'
import type { RegistrySetSiteFields } from './sites'

/** The host platform contract used for path and feature handling. */
export type PlatformMode = 'linux' | 'wsl'

/** A distinction between the trusted Electron host and the browser preview. */
export type HostMode = 'electron' | 'browser'

/** One generation of the supervised sidecar host. */
export interface SidecarHostState {
  state:
    | 'booting'
    | 'starting'
    | 'ready'
    | 'degraded'
    | 'restarting'
    | 'stopping'
    | 'unavailable'
  generation: number
  productVersion: string | null
  protocolVersion: string | null
  persistenceVersions: {
    project: number
    runState: number
    manifest: number
    receipt: number
  } | null
  capabilities: string[]
  runtimeId: string | null
  projectAttached: boolean
  retryable: boolean
  detail: string | null
}

/** The sidecar capabilities required by this desktop contract. */
export const REQUIRED_SIDECAR_CAPABILITIES = [
  'workflow-v1',
  'run-store-v1',
  'project-identity-v1',
  'runtime-events-v1',
  'artifact-resolution-v1',
  'cancellable-provision-v1',
  'input-fov-review-v1',
  'managed-scientific-resources-v1',
  'cohort-analysis-v1',
  'cohort-analysis-v2',
  'atlas-labeling-v1',
] as const

/** The current desktop host and sidecar state. */
export interface HostState {
  mode: HostMode
  platform: PlatformMode | null
  captionMode: 'custom' | 'none'
  sidecar: SidecarHostState
}

/** The identity, configuration, and digest of an opened project. */
export interface ProjectOpenResult {
  project: ProjectRef
  cfg: ProjectConfig
  configSha256: string
}

/** A request for an exact revision-bound project save. */
export interface ProjectSaveRequest {
  project: ProjectRef
  cfg: ProjectConfig
  configRevision: number
  safeExecution: boolean
  expectedSha256: string
}

/** The identity and digest committed by a project save. */
export interface ProjectSaveResult {
  project: ProjectRef
  configRevision: number
  sha256: string
}

/** A project configuration request bound to one exact revision. */
export interface ProjectConfigRequest {
  project: ProjectRef
  cfg: ProjectConfig
  configRevision: number
}

/** The lifecycle phase of one gated environment installation. */
export type EnvInstallPhase = 'queued' | 'running' | 'done' | 'error'

/**
 * Bounded state of one gated environment installation. The sidecar publishes
 * this snapshot on every phase change and while the installer writes output.
 */
export interface EnvInstallState {
  operationId: string
  /** The id of the environment check whose installer this operation runs. */
  checkId: string
  projectId: string
  projectEpoch: number
  phase: EnvInstallPhase
  /** The operation start time in epoch milliseconds. */
  startedAt: number
  /** The time of this snapshot in epoch milliseconds. */
  updatedAt: number
  /** The bounded tail of the combined installer output. */
  output: string
  /** The exit code on a terminal phase, or null while the installer runs. */
  rc: number | null
  /** The bounded captured stdout, populated on a terminal phase. */
  stdout: string
  /** The bounded captured stderr, populated on a terminal phase. */
  stderr: string
}

/** One pipeline stage exposed across IPC. */
export interface StepDescriptor {
  id: number
  key: StepKey
  name: string
  goal: string
  scope: StepScope
  dependencies: StepKey[]
}

/** Explicit selection semantics. Never interpret an empty list as "all." */
export type WorkflowTarget =
  | { mode: 'all' }
  | { mode: 'explicit'; subjectIds: string[] }

/** A complete workflow or one stage over an explicit target. */
export type WorkflowIntent =
  | { kind: 'workflow'; target: WorkflowTarget }
  | { kind: 'stage'; stepKey: StepKey; target: WorkflowTarget }

/** The operator acknowledgements bound to a workflow plan. */
export interface WorkflowAcknowledgements {
  includeDeferredAndUnreviewedQc: boolean
  acknowledgeMemoryAdvisory: boolean
}

/** Authorization for one exact privileged operation for one project revision. */
export interface ExecutionAuthorization {
  token: string
  projectId: string
  configRevision: number
  purpose: 'live-workflow' | 'provision' | 'opt-in-install' | 'cleanup'
  planDigest?: string
}

/** A request for planning or execution of one revision-bound workflow intent. */
export interface WorkflowRequest extends ProjectConfigRequest {
  intent: WorkflowIntent
  acknowledgements: WorkflowAcknowledgements
  approvedPlan?: { planId: string; digest: string }
  liveExecutionAuthorization?: ExecutionAuthorization
}

/** Every state reported for a planned workflow node. */
export type WorkflowNodeStatus = JobStatus | 'skipped'

/** One dependency-bound node in a workflow plan. */
export interface WorkflowNode {
  nodeId: string
  stepKey: StepKey
  scope: StepScope
  subjectId: string | null
  status: WorkflowNodeStatus
  dependencies: string[]
  reason?: string
  command?: string
}

/** A summary of planned, active, blocked, and skipped workflow work. */
export interface WorkflowSummary {
  planned: number
  started: number
  waiting: number
  blocked: number
  skipped: number
  message: string
}

/** One identity-bound workflow plan shown for review. */
export interface WorkflowPlan {
  planId: string
  digest?: string
  configDigest?: string
  qcDigest?: string
  registryDigest?: string
  environmentDigest?: string
  analysisCohort: { subjectIds: string[]; sha256: string }
  selectedSubset: { subjectIds: string[]; sha256: string }
  exclusions?: {
    qcFailedSubjectIds: string[]
    configExcludedSubjectIds: string[]
  }
  resources?: {
    queueSize: number
    availableMemoryGB: number | null
    memoryWarningGB: number
    lowMemory: boolean
  }
  selectionReconciliation?: {
    sourceSubjectIds: string[]
    currentEligibleSubjectIds: string[]
    retainedSubjectIds: string[]
    addedSubjectIds: string[]
    removedSubjectIds: string[]
    deferredAndUnreviewedSubjectIds?: string[]
  }
  nodes: WorkflowNode[]
  blockers: StageBlocker[]
  /**
   * Scientific and resource facts about this plan that block nothing, such
   * as a site without controls that Brain-PAD statistics pool.
   */
  advisories?: string[]
  /**
   * Per-subject reuse forecast for each runnable cohort stage with units,
   * from recorded byte counts. The launch decides again from content
   * digests, so the plan digest does not bind it.
   */
  unitReuse?: UnitReuseForecast[]
  summary: WorkflowSummary
}

/** The disposition and reviewed plan for a workflow request. */
export interface WorkflowResult {
  runId: string | null
  disposition: 'started' | 'planned' | 'noop' | 'blocked'
  plan: WorkflowPlan
  summary: WorkflowSummary
}

/** A request for a reviewed continuation of one interrupted workflow. */
export interface ResumeWorkflowRequest extends ProjectConfigRequest {
  runId: string
  acknowledgements: WorkflowAcknowledgements
  previewOnly?: boolean
  approvedPlan?: { planId: string; digest: string }
  liveExecutionAuthorization?: ExecutionAuthorization
}

/** A request for a reviewed retry of selected workflow nodes. */
export interface RetryWorkflowRequest extends ResumeWorkflowRequest {
  nodeIds?: string[]
  includeCancelled: boolean
  cleanIncomplete: boolean
}

/** Whether cancellation reached one durable run. */
export interface CancelRunResult {
  runId: string
  accepted: boolean
  terminal: boolean
  pendingJobIds: string[]
  message: string
}

/** A function that unsubscribes one renderer event listener. */
export type Unsubscribe = () => void

/** Bounded progress for one environment provisioning operation. */
export interface ProvisionProgress {
  phase: 'env' | 'download' | 'verify' | 'validate' | 'done' | 'error'
  /** Progress from 0 through 100, or null when indeterminate. */
  percent: number | null
  message: string
  projectId: string
  projectEpoch: number
  operationId: string
}

/** One bounded, redacted output line streamed from a provisioning operation. */
export interface ProvisionLogLine {
  projectId: string
  projectEpoch: number
  operationId: string
  /** The sidecar wall-clock time in milliseconds since the Unix epoch. */
  at: number
  line: string
}

/**
 * The current in-app update state. Push it to the renderer on every
 * transition and make it available through `update.getStatus()`.
 *
 * Resolve `capability` once in the main process from the packaging and
 * platform context: `noop` in development and source runs, which never contact
 * the network; `notify` for packaged formats without an in-app install path,
 * such as the Debian package, which check the public GitHub Releases and link
 * the release page; and `full` on Linux AppImage, which can also download and
 * install a confirmed update.
 */
export interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
  version: string | null
  /** Release notes for the available or downloaded version, or null. */
  releaseNotes: string | null
  percent: number | null
  error: string | null
  /** The host capability the main process resolved. */
  capability: 'full' | 'notify' | 'noop'
}

/** The result of one allowed update check. */
export interface UpdateCheckResult {
  available: boolean
  version: string | null
  /** Release notes for the available version, or null. */
  releaseNotes: string | null
}

/** The current PyBrainAge provisioning state. */
export interface ProvisionStatus {
  envReady: boolean
  modelReady: boolean
  pythonExecutable: string | null
  modelPath: string | null
  scalerPath: string | null
  projectId: string
  projectEpoch: number
  configRevision: number
  operationId: string | null
  phase: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  cancellable: boolean
  error: string | null
}

/** A request for authorized PyBrainAge provisioning for one project revision. */
export interface ProvisionRequest extends ProjectConfigRequest {
  sha256?: string
  authorization: ExecutionAuthorization
}

/**
 * A request for authorized BrainCharts provisioning for one project revision.
 * `licenseAccepted` records that the operator accepted the GPL-3.0 notice
 * shown before the download; the sidecar refuses a request without it.
 */
export interface BrainChartsProvisionRequest extends ProjectConfigRequest {
  authorization: ExecutionAuthorization
  licenseAccepted: true
}

/** Whether a provisioning cancellation request was accepted. */
export interface ProvisionCancelResult {
  operationId: string
  accepted: boolean
  terminal: boolean
}

/** Managed-resource progress with added project and operation identity. */
export type ManagedResourceProgress = ManagedResourceStatus & {
  projectId: string
  projectEpoch: number
}

/**
 * A node of a run that did not run, recorded with the blocked reason its run
 * summary quotes. A plan-time blocked node never becomes a job, and a reason
 * such as the Reconstruction output conflict names no subject, so these name
 * whose reason the summary quotes after a restart.
 */
export interface QuotedReasonNode {
  stepKey: StepKey
  subjectId: string | null
  status: 'blocked' | 'withheld' | 'stale'
  reason: string
}

/** One durable run in a runtime snapshot. */
export interface RunSnapshot {
  runId: string
  projectId: string
  projectEpoch: number
  status: JobStatus
  startedAt: number | null
  endedAt: number | null
  dryRun: boolean
  durable: boolean
  analysisSubjectIds?: string[]
  selectedSubjectIds?: string[]
  acknowledgements: WorkflowAcknowledgements
  summary: WorkflowSummary
  /**
   * The nodes behind the blocked reason the summary quotes, read from the
   * run's committed graph; absent when none records it, or when the sidecar
   * would have to list them in part.
   */
  quotedReasonNodes?: QuotedReasonNode[]
}

/** One bounded runtime log line. */
export interface RuntimeLogLine {
  id: string
  runId: string
  jobId: string
  at: number
  level: LogLevel
  line: string
}

/**
 * What the bootstrap replay read of one committed job log file. The replay
 * opens job logs newest first until its line budget or file limit runs out,
 * so a job whose log it never opened has no entry.
 */
export interface RuntimeLogReplay {
  runId: string
  jobId: string
  /** The number of lines read from the file; 0 for an empty file. */
  lines: number
  /** Whether the whole file was read, not only a bounded tail of it. */
  complete: boolean
}

/** The bootstrapped runtime state for one project generation. */
export interface RuntimeSnapshot {
  project: ProjectRef
  sidecarGeneration: number
  sequence: number
  runs: RunSnapshot[]
  jobs: Job[]
  logTail: RuntimeLogLine[]
  /**
   * The replay's coverage of each job log it opened. A snapshot without it
   * carries no coverage, so no job log reads as empty.
   */
  logReplay?: RuntimeLogReplay[]
  provision: ProvisionStatus | null
}

interface RuntimeEventBase {
  projectId: string
  projectEpoch: number
  sidecarGeneration: number
  sequence: number
  runId: string | null
  at: number
}

/**
 * The reviewed operator precondition that leaves QC review unavailable.
 *
 * `earlierGallery` names the newest run whose galleries exist but cannot back
 * new verdicts; they stay non-authoritative. `message` states the reason: an
 * earlier project configuration, an ENIGMA QC input that changed after the
 * run, or an inventory Supraspina could not verify. `noCurrentGallery` covers
 * every other absence, including a newest ENIGMA run whose inventory failed.
 */
export type QcAuthorityUnavailable =
  | { reason: 'noCurrentGallery'; message: string }
  | { reason: 'earlierGallery'; message: string; earlierRunId: string }

/** The authoritative QC gallery run, or its typed expected absence. */
export interface QcAuthoritativeRun {
  runId: string | null
  unavailable: QcAuthorityUnavailable | null
  /**
   * An opaque token that changes whenever the authoritative run's gallery
   * inventory may have changed, or null without an authoritative run. A
   * renderer may reuse an inventory it read under the same token.
   */
  inventoryKey: string | null
}

/** One published sequence-bound runtime state transition. */
export type RuntimeEvent =
  | (RuntimeEventBase & { kind: 'job'; job: Job })
  | (RuntimeEventBase & { kind: 'run'; run: RunSnapshot })
  | (RuntimeEventBase & { kind: 'log'; log: RuntimeLogLine })
  | (RuntimeEventBase & { kind: 'provision'; provision: ProvisionStatus })
  | (RuntimeEventBase & {
      kind: 'summary'
      summary: WorkflowSummary
    })

/** One page of durable run manifests with an opaque cursor. */
export interface ManifestPage {
  items: RunManifest[]
  nextCursor: string | null
}

/** How a declared result relates to current filesystem evidence. */
export type ResultPresence =
  | 'expected'
  | 'produced'
  | 'absent'
  | 'partial'
  | 'unknown'

/** Verified receipt evidence for one result artifact. */
export interface ResultReceiptProvenance {
  receiptVersion: number | null
  signature: string
  signatureValid: boolean
  committedAtMs: number | null
  jobId: string | null
  analysisCohortDigest: string | null
  selectedSubsetDigest: string | null
  inputT1Fingerprint: string | null
  stepParamsDigest: string | null
  adapterIdentity: string | null
  adapterImplementationSha256: string | null
  toolEvidenceDigest: string | null
  externalInputsDigest: string | null
  outputSchemaIdentity: string | null
  upstreamSignatures: string[]
  baselineDigest: string | null
  /**
   * The flags a Reconstruction reran with after a known FreeSurfer failure,
   * from the receipt record, or null when it did not rerun.
   */
  executionFallback?: ExecutionFallback | null
  /**
   * Which subjects the producing cohort stage computed and which kept
   * verified earlier output, from the receipt record, or null without one.
   */
  unitReuse?: UnitReuseSummary | null
}

/** The reviewed run inputs bound to a result artifact. */
export interface ResultRunBindingProvenance {
  planDigest: string | null
  configDigest: string | null
  qcDigest: string | null
  registryDigest: string | null
  environmentDigest: string | null
}

/** Combined receipt and run-binding provenance for one result. */
export interface ResultProvenanceDetails {
  receipt: ResultReceiptProvenance | null
  runBinding: ResultRunBindingProvenance | null
}

/** One bounded result artifact returned to the renderer. */
export interface ResultArtifact {
  artifactId: string
  label: string
  stepKey: StepKey
  subjectId: string | null
  kind: 'dir' | 'csv' | 'png' | 'html' | 'xlsx' | 'pdf' | 'txt' | 'nii'
  presence: ResultPresence
  displayPath: string
  exists: boolean
  openable: boolean
  revealable: boolean
  runId: string | null
  producerNodeId: string | null
  receiptSha256: string | null
  provenance: 'current' | 'stale' | 'unknown'
  provenanceDetails?: ResultProvenanceDetails | null
  detail?: string
}

/**
 * Whether the planner would reuse one stage's receipts as they are.
 *
 * A stage is `current` when a published receipt matches what the stage would
 * compute now and its outputs still match that receipt; `outdated` means the
 * planner would run it again.
 */
export interface ResultStageCurrency {
  state: 'current' | 'outdated' | 'unknown'
  /** Per-subject stages only: the subjects whose receipt is not current. */
  outdatedSubjectIds: string[]
  /**
   * Cohort stages only: why an out-of-date stage is out of date, when known.
   * `analysis-cohort` means its receipt matches the run's analysis cohort but
   * not the one the next Run all would plan: the subjects, their T1 inputs,
   * or the configuration or QC Fail exclusions changed. The page's
   * `analysisCohortChange` says which.
   */
  cause?: 'analysis-cohort'
}

/**
 * One thing that changed the analysis membership since the inspected run.
 *
 * - `subjects-added`: a subject folder with one T1 appeared under raw data.
 * - `subjects-removed`: a subject the run analyzed is no longer found.
 * - `config-exclusion`: the saved configuration includes or excludes other
 *   subjects; `subjectIds` may be empty when only the exclusion list changed.
 * - `t1-changed`: an analyzed subject's T1 file changed or moved.
 * - `qc-exclusion`: a QC Fail verdict now excludes, or no longer excludes, a
 *   subject.
 *
 * `subjectIds` lists at most 20 subjects, sorted; `count` is the total.
 */
export interface ResultAnalysisCohortReason {
  kind:
    | 'subjects-added'
    | 'subjects-removed'
    | 'config-exclusion'
    | 't1-changed'
    | 'qc-exclusion'
  subjectIds: string[]
  count: number
}

/**
 * How the analysis cohort the next Run all would plan differs from the one
 * the inspected run recorded. That cohort is resolved from the saved
 * configuration, the subjects and T1 files under raw data, and the current QC
 * verdicts. `membership` means its subjects, T1 inputs, or exclusions
 * changed, and `reasons` names what changed. Cohort receipts bind the
 * membership and ignore verdicts.
 */
export interface ResultAnalysisCohortChange {
  cause: 'membership'
  reasons?: ResultAnalysisCohortReason[]
}

/** One page of result artifacts and their detector context. */
export interface ResultPage {
  items: ResultArtifact[]
  nextCursor: string | null
  truncated: boolean
  /** Run whose detector inventory was inspected, including for an empty page. */
  runId?: string | null
  configSha256?: string | null
  total?: number
  producedStepKeys?: StepKey[]
  /** Receipt currency per stage across the whole inventory, not one page. */
  stageCurrency?: Partial<Record<StepKey, ResultStageCurrency>>
  /** The analysis-cohort change since the inspected run, or null for none. */
  analysisCohortChange?: ResultAnalysisCohortChange | null
}

/** One reviewed QC gallery bound to its run and receipt evidence. */
export interface QcGalleryReviewEvidence {
  tab: 'subcortical' | 'internal' | 'external'
  label: string
  displayPath: string
  runId: string
  receiptSha256: string
  openedAt: string
}

/** The complete three-gallery evidence for one QC verdict. */
export interface QcReviewEvidence {
  evidenceVersion: 1
  reviewer: string
  reviewedAt: string
  galleries: QcGalleryReviewEvidence[]
}

/** One detector-verified QC gallery image. */
export interface QcGalleryImage {
  artifactId: string
  displayPath: string
  bytes: number
  sha256: string
}

/** One QC montage panel paired with its full-resolution image. */
export interface QcGalleryPanel {
  key: string
  group: string
  detail: string
  /** The complete human-readable panel name. */
  label: string
  montage: QcGalleryImage
  full: QcGalleryImage
}

/** The complete detector-verified QC view for one subject. */
export interface QcGalleryView {
  tab: QcGalleryReviewEvidence['tab']
  subjectId: string
  runId: string
  receiptSha256: string
  inventoryRunId: string
  panels: QcGalleryPanel[]
  /**
   * The render that replaced the images the subject's recorded verdict was
   * reviewed on, when its inputs or the rendering method changed.
   */
  imagesChangedSinceVerdict?: ImagesChangedSinceVerdict
}

/** Authorization to review one exact QC gallery identity for a bounded time. */
export interface QcReviewOpenGrant {
  grantId: string
  tab: QcGalleryReviewEvidence['tab']
  subjectId: string
  inventoryRunId: string
  runId: string
  receiptSha256: string
  openedAt: string
  expiresAt: string
}

/** One bounded text preview from a resolved artifact. */
export interface ArtifactTextPreview {
  text: string
  truncated: boolean
}

/** One bounded image preview from a resolved artifact. */
export interface ArtifactImagePreview {
  dataUrl: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  truncated: boolean
}

/** A summary of one selectable category in a debug bundle. */
export interface DebugBundleCategory {
  id: string
  label: string
  fileCount: number
  estimatedBytes: number
  redactions: string[]
  truncated: boolean
}

/** A preview of the bounded contents and redaction policy of a debug bundle. */
export interface DebugBundlePreview {
  runId: string
  categories: DebugBundleCategory[]
  totalFiles: number
  estimatedBytes: number
  redactionPolicy: string
  truncated: boolean
}

/** One main-approved save destination that exposes no authority. */
export interface SaveDestination {
  destinationId: string
  displayPath: string
}

/** One canonical subject registry record. */
export interface RegistryRecord {
  subjectId: string
  /** The recorded age at scan in years, or null when it is not recorded. */
  age: number | null
  sex: Sex
  sourceCohortLabel: string
  cohortRole: CohortRole
  ais: AisGrade | null
  tSinceSci: number | null
  t1Availability: 'available' | 'missing' | 'ambiguous'
  runnable: boolean
  unavailableReason: string | null
  qc: QcVerdict | null
  recordedQcVerdict?: QcVerdict | null
  qcReviewEvidencePresent?: boolean
  qcNote: string
  qcTags: string[]
  revision: number
  updatedAt: string
  /**
   * The acquisition site (scanner plus protocol), or null when unset. The
   * sidecar stores the key only when a site is set, so a registry without
   * sites keeps its bytes; the parser reads a missing key as null.
   */
  site: string | null
}

/** The editable subject registry fields for an upsert. */
export interface RegistryInput {
  subjectId: string
  /** The age at scan in years, or null when it is not recorded. */
  age: number | null
  sex: Sex
  sourceCohortLabel: string
  ais: AisGrade | null
  tSinceSci: number | null
  /**
   * The site to store: a label sets it, and null or blank text clears it.
   * Omit the key to keep the stored site, so an editor that never shows the
   * field cannot drop it.
   */
  site?: string | null
}

/** A request to set or clear the site of several subjects in one write. */
export interface RegistrySetSiteRequest extends RegistrySetSiteFields {
  project: ProjectRef
}

/** The outcome of one atomic `registry.setSite` write. */
export interface RegistrySetSiteResult {
  /** The normalized label that was set, or null when the site was cleared. */
  site: string | null
  /** The records written; each record's revision rose by one. */
  updated: number
}

/** The deterministic import policy for already-registered subject IDs. */
export type RegistryImportOnExisting = 'skip' | 'update'

/** One file- or row-scoped message from a registry CSV import. */
export interface RegistryImportIssue {
  /**
   * The 1-based CSV record number, counting the header as row 1, or null for
   * a file-level issue.
   */
  row: number | null
  message: string
}

/** The sidecar-validated outcome of one all-or-nothing registry CSV import. */
export interface RegistryImportResult {
  /** Whether the rows were applied; false when any error rejected the file. */
  applied: boolean
  imported: number
  updated: number
  skipped: number
  /** The first reported issues; the totals below carry the full counts. */
  errors: RegistryImportIssue[]
  warnings: RegistryImportIssue[]
  errorTotal: number
  warningTotal: number
}

/** One operator-chosen import file read by the main process. */
export interface RegistryImportFile {
  name: string
  displayPath: string
  text: string
}

/** A request for a revision-checked QC annotation or verdict write. */
export interface QcWriteRequest {
  project: ProjectRef
  subjectId: string
  verdict: QcVerdict | null
  note: string
  tags: string[]
  reviewGrantIds?: string[]
  annotationOnly?: boolean
  expectedRevision?: number
}

/** The canonical QC record committed by a write. */
export interface QcWriteResult {
  subjectId: string
  verdict: QcVerdict | null
  note: string
  tags: string[]
  reviewEvidence?: QcReviewEvidence | null
  revision: number
  updatedAt: string
}

/** One destructive application lifecycle transition. */
export type BoundaryIntent =
  | 'window-close'
  | 'app-quit'
  | 'update-install'
  | 'renderer-reload'

/** A request for one bounded renderer decision at a lifecycle boundary. */
export interface BoundaryRequest {
  requestId: string
  intent: BoundaryIntent
}

/** How Supraspina chooses a display for its main window. */
export type WindowPlacementPreference =
  | { mode: 'remember' }
  | { mode: 'primary' }
  | { mode: 'display'; displayId: string }

/** One display described without exposing unrestricted Electron objects. */
export interface WindowPlacementDisplay {
  id: string
  number: number
  primary: boolean
  resolution: { width: number; height: number }
  workArea: { width: number; height: number }
  scaleFactor: number
  label?: string
}

/** The saved and resolved main-window placement. */
export interface WindowPlacementState {
  preference: WindowPlacementPreference
  displays: WindowPlacementDisplay[]
  resolvedDisplayId: string
  fallbackReason: 'selected-display-unavailable' | null
  unavailableDisplayLabel?: string
}

/** The complete typed renderer authority exposed by preload. */
export interface SupraspinaApi {
  project: {
    create(request: {
      at: string
      cfg: ProjectConfig
      epoch: number
    }): Promise<ProjectOpenResult>
    open(request: { path: string; epoch: number }): Promise<ProjectOpenResult>
    close(request: { project: ProjectRef }): Promise<void>
    save(request: ProjectSaveRequest): Promise<ProjectSaveResult>
    validate(
      cfg: ProjectConfig,
    ): Promise<{ errors: string[]; warnings: string[] }>
  }

  host: {
    getState(): Promise<HostState>
    retrySidecar(): Promise<void>
    onState(cb: (state: HostState) => void): Unsubscribe
  }
  preferences: {
    get(): Promise<MachinePreferencesState>
    patch(patch: MachinePreferencesPatch): Promise<MachinePreferencesState>
    reset(): Promise<MachinePreferencesState>
    onChanged(cb: (state: MachinePreferencesState) => void): Unsubscribe
  }
  windowPlacement: {
    getState(): Promise<WindowPlacementState>
    setPreference(
      preference: WindowPlacementPreference,
    ): Promise<WindowPlacementState>
    moveNow(): Promise<WindowPlacementState>
    identifyDisplays(): Promise<void>
    onTopologyChanged(cb: (state: WindowPlacementState) => void): Unsubscribe
  }
  platform: {
    detect(): Promise<PlatformMode>
    cpuCount(): Promise<number | null>
    toNative(p: string): Promise<string>
    fromNative(p: string): Promise<string>
  }
  fs: {
    chooseDir(opts?: { defaultPath?: string }): Promise<string | null>
    chooseFile(opts?: {
      filters?: { name: string; extensions: string[] }[]
    }): Promise<string | null>
    chooseSavePath(opts: {
      purpose: 'subjects-csv' | 'debug-bundle' | 'registry-import-example'
      project: ProjectRef
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }): Promise<SaveDestination | null>
  }

  external: {
    openWeb(request: {
      url: string
      purpose: 'documentation' | 'download' | 'releases' | 'support'
    }): Promise<void>
    /** Open the exact public redistribution notices bundled by main. */
    openThirdPartyNotices(): Promise<void>
  }
  execution: {
    authorize(request: {
      project: ProjectRef
      configRevision: number
      purpose: ExecutionAuthorization['purpose']
      planDigest?: string
    }): Promise<ExecutionAuthorization>
  }

  /** Open/reveal only an artifact identity returned by `results.list`. */
  artifact: {
    open(request: {
      project: ProjectRef
      artifactId: string
      focusText?: string
    }): Promise<{
      openedAt: string
      reviewGrant: QcReviewOpenGrant | null
    }>
    reveal(request: { project: ProjectRef; artifactId: string }): Promise<void>
    list(request: {
      project: ProjectRef
      artifactId: string
      cursor?: string
      limit?: number
    }): Promise<ResultPage>
    readText(request: {
      project: ProjectRef
      artifactId: string
      maxBytes?: number
    }): Promise<ArtifactTextPreview>
    previewImage(request: {
      project: ProjectRef
      artifactId: string
      maxBytes?: number
    }): Promise<ArtifactImagePreview>
  }

  /** Resolve the newest review-authoritative ENIGMA gallery inventory. */
  qc: {
    /**
     * Resolve the authoritative gallery run, or report the governed operator
     * precondition that no current gallery set exists. Treat the absent set as
     * an expected answer rather than a failure: the project may simply not have
     * run ENIGMA QC under the saved configuration yet.
     */
    authoritativeRun(request: {
      project: ProjectRef
    }): Promise<QcAuthoritativeRun>
    /**
     * Describe the detector-verified montage the app may draw for one subject
     * of one current gallery. Never return a path the detector did not verify.
     */
    galleryImages(request: {
      project: ProjectRef
      artifactId: string
      subjectId: string
    }): Promise<QcGalleryView>
    /**
     * Attest that the app displayed the complete montage for one subject and
     * gallery, then mint the same review grant an external open would.
     */
    attestGalleryView(request: {
      project: ProjectRef
      artifactId: string
      subjectId: string
    }): Promise<{ reviewGrant: QcReviewOpenGrant }>
  }
  env: {
    /**
     * Check the environment. Without a project, pass only the optional check
     * ids: the read-only probes run host-scoped and project-scoped checks
     * report as skipped until a project supplies its configuration.
     */
    check(
      request: (ProjectConfigRequest & { ids?: string[] }) | { ids?: string[] },
    ): Promise<EnvReport>
    /**
     * Start one check's gated installer and return its operation identity.
     * Watch `onInstallProgress` for the phase, output, and exit code; the
     * sidecar refuses a second installation while one is unsettled.
     */
    optInInstall(
      request: ProjectConfigRequest & {
        checkId: string
        authorization: ExecutionAuthorization
      },
    ): Promise<{ operationId: string }>
    /**
     * List the installations the sidecar retains for one project generation,
     * so a remounting screen reattaches to one that is still running.
     */
    installStatus(request: {
      project: ProjectRef
    }): Promise<{ operations: EnvInstallState[] }>
    /**
     * Create the output directory a check's typed `create-directory` action
     * names. The renderer sends only the check id; the sidecar derives the
     * path from the saved configuration and refuses symlinks, files, and
     * paths outside the derivatives directory.
     */
    createOutputDir(
      request: ProjectConfigRequest & {
        checkId: string
        authorization: ExecutionAuthorization
      },
    ): Promise<EnvCreateDirResult>
    toolStatus(request: ProjectConfigRequest): Promise<ToolStatus>
    onInstallProgress(cb: (ev: EnvInstallState) => void): Unsubscribe
  }

  provision: {
    pybrainage(request: ProvisionRequest): Promise<{ operationId: string }>
    synthstrip(
      request: ProjectConfigRequest & {
        authorization: ExecutionAuthorization
      },
    ): Promise<{ operationId: string }>
    fastsurfer(
      request: ProjectConfigRequest & {
        variant: 'cpu' | 'cuda'
        authorization: ExecutionAuthorization
      },
    ): Promise<{ operationId: string }>
    /**
     * Download the BrainCharts model and build its runtime after the operator
     * accepted the GPL-3.0 license notice. Progress arrives through
     * `onProgress` and `onLog`; `cancel` takes the returned operation ID.
     */
    braincharts(
      request: BrainChartsProvisionRequest,
    ): Promise<{ operationId: string }>
    status(request: { project: ProjectRef }): Promise<ProvisionStatus>
    cancel(request: {
      project: ProjectRef
      operationId: string
    }): Promise<ProvisionCancelResult>
    onProgress(cb: (ev: ProvisionProgress) => void): Unsubscribe
    onLog(cb: (ev: ProvisionLogLine) => void): Unsubscribe
  }

  managedResource: {
    status(
      request: ProjectConfigRequest & ManagedResourceSelector,
    ): Promise<ManagedResourceStatusResult>
    cancel(
      request: ProjectConfigRequest &
        ManagedResourceSelector & {
          operationId: string
        },
    ): Promise<ProvisionCancelResult>
    importOffline(
      request: ProjectConfigRequest &
        ManagedResourceSelector & {
          sourcePath: string
          authorization: ExecutionAuthorization
        },
    ): Promise<{ operationId: string }>
    onProgress(cb: (ev: ManagedResourceProgress) => void): Unsubscribe
  }

  inputFov: {
    list(request: ProjectConfigRequest): Promise<InputFovListResult>
    review(
      request: ProjectConfigRequest & InputFovReviewFields,
    ): Promise<InputFovReview>
  }

  /**
   * The advisory surface-registration check. Main supplies the saved
   * configuration. `check` starts a background check of every hemisphere
   * without a current result and returns at once; `status` reports its
   * progress and every result. The check never sets a QC verdict.
   */
  surfaceRegistration: {
    status(request: { project: ProjectRef }): Promise<SurfaceRegistrationStatus>
    check(request: {
      project: ProjectRef
      /** Check hemispheres whose last check failed again. */
      retryFailed?: boolean
    }): Promise<SurfaceRegistrationCheckResult>
    cancel(request: {
      project: ProjectRef
      operationId: string
    }): Promise<SurfaceRegistrationCancelResult>
  }

  /**
   * The interactive group analysis. Main supplies the saved configuration to
   * every sidecar call; `start` returns at once and `status` reports the
   * compute, polled while it runs. Nothing here plans, runs a pipeline stage,
   * or writes outside `.supraspina/analysis/` and an explicit export folder.
   */
  groupAnalysis: {
    catalog(request: { project: ProjectRef }): Promise<GroupAnalysisCatalog>
    /** Resolve a draft's sample (and a spec v2's design check) without computing. */
    inputs(request: {
      project: ProjectRef
      spec: AnyGroupAnalysisSpec
    }): Promise<GroupAnalysisInputs>
    start(request: {
      project: ProjectRef
      spec: AnyGroupAnalysisSpec
      /** The stage currency the renderer shows, stored with the result. */
      stageCurrency: AnalysisStageCurrency
    }): Promise<GroupAnalysisStartResult>
    status(request: { project: ProjectRef }): Promise<GroupAnalysisStatus>
    cancel(request: {
      project: ProjectRef
      operationId: string
    }): Promise<GroupAnalysisCancelResult>
    list(request: { project: ProjectRef }): Promise<GroupAnalysisList>
    /** A v1 result whole, or a v2 result's header, terms, and first term. */
    result(request: {
      project: ProjectRef
      resultId: string
    }): Promise<AnyGroupAnalysisResult>
    /** Page one term's rows of a v2 result from `offset`. */
    termRows(request: {
      project: ProjectRef
      resultId: string
      termId: string
      offset: number
    }): Promise<GroupAnalysisTermRows>
    measureDetail(request: {
      project: ProjectRef
      resultId: string
      measureId: string
    }): Promise<GroupAnalysisMeasureDetail>
    /** One measure of one term of a v2 result, with fitted lines. */
    measureDetail(request: {
      project: ProjectRef
      resultId: string
      measureId: string
      termId: string
    }): Promise<GroupAnalysisMeasureDetailV2>
    /** Create (`specId` null) or replace a saved specification. */
    saveSpec(request: {
      project: ProjectRef
      specId: string | null
      name: string
      spec: AnyGroupAnalysisSpec
      expectedRevision: number
    }): Promise<GroupAnalysisLibrary>
    deleteSpec(request: {
      project: ProjectRef
      specId: string
      expectedRevision: number
    }): Promise<GroupAnalysisLibrary>
    /** Create (`setId` null) or replace an unlocked ROI set. */
    saveSet(request: {
      project: ProjectRef
      setId: string | null
      name: string
      measures: string[]
      expectedRevision: number
    }): Promise<GroupAnalysisLibrary>
    /** Lock a set: record its SHA-256 and time; it never changes again. */
    lockSet(request: {
      project: ProjectRef
      setId: string
      expectedRevision: number
    }): Promise<GroupAnalysisLibrary>
    deleteSet(request: {
      project: ProjectRef
      setId: string
      expectedRevision: number
    }): Promise<GroupAnalysisLibrary>
    /**
     * Choose and read one CSV of measure IDs through a native dialog for
     * "Import set". Return null when the operator cancels.
     */
    chooseSetCsv(request: {
      project: ProjectRef
    }): Promise<RegistryImportFile | null>
    /**
     * Choose the parent folder of an export through a native dialog,
     * starting at `<projectRoot>/exports/analysis`. Return null on cancel.
     */
    chooseExportFolder(request: {
      project: ProjectRef
      /** The suggested folder name, `<YYYY-MM-DD>-<slug>`. */
      defaultName: string
    }): Promise<SaveDestination | null>
    /** Create the export folder exclusively and write every file. */
    writeExport(
      request: GroupAnalysisExportRequest & { project: ProjectRef },
    ): Promise<GroupAnalysisExportResult>
    /**
     * Choose a CSV of per-subject variables through a native dialog; main
     * hands the path to the sidecar, which copies it with bounded reads
     * into `.supraspina/analysis/variables/`. Return null on cancel.
     */
    chooseVariablesCsv(request: {
      project: ProjectRef
    }): Promise<AnalysisVariableTable | null>
    /**
     * Remove an imported variables table after a native confirmation.
     * Return false when the operator keeps it.
     */
    removeVariables(request: {
      project: ProjectRef
      tableId: string
    }): Promise<boolean>
    /**
     * The atlases of the project: tier A sources, tier B labeled atlases,
     * added atlases, tool facts, and the labeling operation.
     */
    atlases(request: {
      project: ProjectRef
      /**
       * The subjects whose reconstruction the renderer's stage currency
       * marks out of date (at most 5000), counted in `reconOutdated`.
       */
      reconOutdatedSubjectIds: string[]
    }): Promise<AtlasCatalog>
    /** Start labeling one atlas; return at once (one operation at a time). */
    labelStart(
      request: AtlasLabelStartRequest & { project: ProjectRef },
    ): Promise<AtlasLabelStartResult>
    /** The labeling operation and one atlas's per-subject label states. */
    labelStatus(request: {
      project: ProjectRef
      /** The atlas to list, or null for the operation's atlas. */
      atlasId: string | null
    }): Promise<AtlasLabelStatus>
    /** Stop the labeling; finished subjects keep their labels. */
    labelCancel(request: {
      project: ProjectRef
      operationId: string
    }): Promise<AtlasLabelCancelResult>
    /** Remove cached labels of one atlas from `.supraspina/analysis/atlases/`. */
    clearLabels(
      request: AtlasClearLabelsRequest & { project: ProjectRef },
    ): Promise<AtlasLabelsCleared>
    /**
     * Add an atlas from files the operator chooses in a native dialog (a
     * gcs pair, an annot pair, or a subject-space label map with its LUT),
     * with the license the operator confirmed. Return null on cancel.
     */
    chooseAtlasFiles(request: {
      project: ProjectRef
      recipeId: Extract<
        AtlasRecipeId,
        'user-gcs' | 'user-annot' | 'user-volume'
      >
      label: string
      license: { name: string; url: string | null }
      /** The external source the files came from, when known. */
      externalSourceId: string | null
    }): Promise<AtlasImportResult | null>
    /**
     * Import existing labeling outputs (for example subregion volumes made
     * elsewhere) from a folder of per-subject folders chosen in a native
     * dialog. Return null on cancel.
     */
    chooseLabelsFolder(request: {
      project: ProjectRef
      atlasId: string
    }): Promise<AtlasLabelsImportResult | null>
  }

  /**
   * The external atlas sources and their machine-level cache
   * (`<userData>/atlases/<sourceId>/<version>/`), shared by projects. A
   * download fetches pinned files with progress, a size and SHA-256 check,
   * and cancel, after the operator acknowledges the license; `openPage`
   * opens only a source's allowlisted https page. None of this touches the
   * managed scientific resources, their pins, the environment check, or
   * receipts. The subregions interpreter is the machine preference
   * `subregionsPython` (never a project setting).
   */
  atlasSources: {
    list(): Promise<AtlasSourcesList>
    download(request: {
      sourceId: string
      /** The operator acknowledged the license shown first. */
      licenseAcknowledged: true
    }): Promise<AtlasDownloadStartResult>
    status(): Promise<AtlasDownloadStatus>
    cancel(request: { operationId: string }): Promise<AtlasDownloadCancelResult>
    /** Open a source's catalog page or license URL, nothing else. */
    openPage(request: {
      sourceId: string
      kind: AtlasSourceUrlKind
    }): Promise<void>
    /**
     * Choose the Python 3.12 interpreter that runs FreeSurfer's subregion
     * segmentation, through a native dialog; return its path, or null on
     * cancel.
     */
    chooseSubregionsPython(): Promise<string | null>
    clearSubregionsPython(): Promise<void>
  }

  /**
   * Read the FreeSurfer template (and one subject's volumes) for the 3D and
   * slice views. Main resolves the FreeSurfer home and reads only the
   * allowlisted files.
   */
  brainViewer: {
    assets(
      request: BrainAssetsRequest & { project: ProjectRef },
    ): Promise<BrainAssetsReport>
    readAsset(
      request: BrainAssetReadRequest & { project: ProjectRef },
    ): Promise<BrainAsset>
  }

  subjects: {
    discover(request: ProjectConfigRequest): Promise<Subject[]>
    refreshOne(
      request: ProjectConfigRequest & { subjectId: string },
    ): Promise<Subject>
    openFolder(request: {
      project: ProjectRef
      subjectId: string
    }): Promise<void>
    openLog(request: {
      project: ProjectRef
      subjectId: string
      stepKey?: StepKey
    }): Promise<void>
    exportCsv(request: {
      project: ProjectRef
      rows: Subject[]
      destinationId: string
    }): Promise<void>
    markQc(request: QcWriteRequest): Promise<QcWriteResult>
  }

  registry: {
    list(request: { project: ProjectRef }): Promise<RegistryRecord[]>
    upsert(request: {
      project: ProjectRef
      record: RegistryInput
      expectedRevision?: number
    }): Promise<RegistryRecord>
    /**
     * Choose and read one CSV file through a native main-process dialog.
     * Return null when the operator cancels the dialog.
     */
    chooseImportCsv(request: {
      project: ProjectRef
    }): Promise<RegistryImportFile | null>
    /**
     * Validate the CSV entirely in the sidecar and import every row through
     * one atomic write, or apply nothing when any error rejects the file.
     */
    importCsv(request: {
      project: ProjectRef
      csvText: string
      onExisting: RegistryImportOnExisting
    }): Promise<RegistryImportResult>
    /** Write the bundled example CSV to a main-approved save destination. */
    saveExampleCsv(request: {
      project: ProjectRef
      destinationId: string
    }): Promise<void>
    remove(request: {
      project: ProjectRef
      subjectId: string
      expectedRevision?: number
    }): Promise<void>
    /**
     * Set or clear the site of every named subject in one atomic write,
     * refusing the whole request when any record moved past its expected
     * revision.
     */
    setSite(request: RegistrySetSiteRequest): Promise<RegistrySetSiteResult>
  }

  pipeline: {
    listSteps(): Promise<StepDescriptor[]>
    previewCommand(
      cfg: ProjectConfig,
      key: StepKey,
      subjectId?: string,
    ): Promise<string>
    planWorkflow(request: WorkflowRequest): Promise<WorkflowResult>
    runWorkflow(request: WorkflowRequest): Promise<WorkflowResult>
    resumeWorkflow(request: ResumeWorkflowRequest): Promise<WorkflowResult>
    retryWorkflow(request: RetryWorkflowRequest): Promise<WorkflowResult>
    cancelRun(request: {
      project: ProjectRef
      runId: string
    }): Promise<CancelRunResult>
    onJobUpdate(cb: (j: Job) => void): Unsubscribe
    onStdout(
      cb: (jobId: string, line: string, lev: LogLevel) => void,
    ): Unsubscribe
  }

  runtime: {
    bootstrap(request: {
      project: ProjectRef
      runLimit?: number
      logLimit?: number
    }): Promise<RuntimeSnapshot>
    onEvent(cb: (event: RuntimeEvent) => void): Unsubscribe
  }

  manifest: {
    forRun(request: {
      project: ProjectRef
      runId: string
    }): Promise<RunManifest>
    list(request: {
      project: ProjectRef
      cursor?: string
      limit?: number
    }): Promise<ManifestPage>
    previewDebug(request: {
      project: ProjectRef
      runId: string
    }): Promise<DebugBundlePreview>
    bundleDebug(request: {
      project: ProjectRef
      runId: string
      categoryIds: string[]
      destinationId: string
      consent: true
      redaction: 'required'
    }): Promise<{ artifactId: string; displayPath: string }>
  }

  results: {
    list(request: {
      project: ProjectRef
      runId?: string
      stepKey?: StepKey
      query?: string
      cursor?: string
      limit?: number
    }): Promise<ResultPage>
  }

  lifecycle: {
    onBoundaryRequested(cb: (request: BoundaryRequest) => void): Unsubscribe
    respondBoundary(request: {
      requestId: string
      decision: 'proceed' | 'cancel'
      reason?: string
    }): Promise<void>
  }

  /**
   * Control the frameless native window from the renderer's custom title bar.
   * Use `onMaximizeChange` to keep the maximize and restore
   * affordance aligned with the real window state.
   */
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    onMaximizeChange(cb: (maximized: boolean) => void): Unsubscribe
  }

  /**
   * Check for and download in-app updates through electron-updater. The main
   * process gates every action: a no-op in development, notification only for
   * formats without an in-app install path, and confirmed download and
   * installation on Linux AppImage. Use `onStatus` like
   * `window.onMaximizeChange`: an event-only push fed from the main process.
   */
  update: {
    check(): Promise<UpdateCheckResult>
    download(): Promise<void>
    installNow(): Promise<void>
    getStatus(): Promise<UpdateState>
    onStatus(cb: (s: UpdateState) => void): Unsubscribe
  }
}
