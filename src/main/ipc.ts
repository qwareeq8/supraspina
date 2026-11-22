/** Enforces the main-process IPC trust boundary and native project services. */

import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, existsSync, readFileSync, type Stats } from 'node:fs'
import {
  lstat,
  link,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { cpus, userInfo } from 'node:os'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  shell,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
} from 'electron'
import type {
  ArtifactImagePreview,
  ArtifactTextPreview,
  BoundaryIntent,
  ExecutionAuthorization,
  HostState,
  PlatformMode,
  ProjectOpenResult,
  ProjectSaveRequest,
  ProjectSaveResult,
  QcAuthorityUnavailable,
  QcWriteRequest,
  QcWriteResult,
  QcGalleryImage,
  QcGalleryPanel,
  QcGalleryReviewEvidence,
  QcGalleryView,
  QcReviewOpenGrant,
  QcReviewEvidence,
  ResultArtifact,
  ResultPage,
  SaveDestination,
  SidecarHostState,
} from '../shared/contract'
import surface from '../shared/ipc-surface.json'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import {
  MAX_REGISTRY_IMPORT_BYTES,
  REGISTRY_IMPORT_EXAMPLE_CSV,
} from '../shared/registry-import'
import {
  validateProjectConfig,
  type ProjectConfig,
} from '../shared/project-schema'
import { MATRIX_STEPS, STEP_KEYS, type StepKey } from '../shared/steps'
import { flattenConfig, resolveTemplate } from '../shared/template'
import type { ProjectRef, Subject } from '../shared/types'
import { normalizeAnalysisEligibility } from '../shared/analysis-cohort'
import {
  BoundaryExpiredError,
  PlanStaleError,
  serializePublicRpcError,
} from '../shared/rpc-errors'
import {
  parseInputFovListResult,
  parseInputFovReviewRequest,
  parseInputFovReviewResult,
  parseManagedResourceProgress,
  parseManagedResourceRequest,
  parseManagedResourceStatusResult,
  type InputFovListResult,
} from '../shared/scientific-contracts'
import {
  parseEnvInstallState,
  parsePipelineStdout,
  parseProvisionLog,
  parseProvisionProgress,
  parseRuntimeEvent,
  parseRuntimeJob,
} from '../shared/runtime-contracts'
import {
  contractRowIndex,
  parseSidecarRpcResult,
} from '../shared/rpc-result-contracts'
import {
  emptyQcStore,
  isValidQcSubjectId,
  MAX_QC_NOTE_LENGTH,
  MAX_QC_TAG_LENGTH,
  MAX_QC_TAGS,
  parseQcStore,
  type QcStoreDocument,
} from '../shared/qc-store'
import { REGISTRATION_OPERATION_ID } from '../shared/surface-registration'
import { isSiteLabel, parseRegistrySetSiteFields } from '../shared/sites'
import { parseImagesChangedSinceVerdict } from '../shared/unit-reuse'
import {
  ATLAS_DOWNLOAD_OPERATION_ID,
  ATLAS_LABELING_REQUEST_FIELDS,
  ATLAS_SOURCES,
  ATLAS_SOURCE_URL_KINDS,
  atlasSourceUrl,
  type AtlasSourceUrlKind,
  parseAtlasCatalog,
  parseAtlasImportResult,
  parseAtlasLabelsImportResult,
  validateAtlasLabelingRequest,
} from '../shared/atlas-labeling'
import { AtlasSourceManager, atlasCacheRoot } from './atlas-sources'
import { checkSubregionsPython } from './subregions-python'
import {
  ATLAS_IMPORT_EXTENSIONS,
  MAX_VARIABLES_CSV_BYTES,
  checkChosenAtlasFiles,
  checkChosenFile,
  checkChosenFolder,
} from './analysis-imports'
import {
  ATLAS_ID,
  VARIABLE_TABLE_ID,
  parseAnalysisVariableTable,
  parseGroupAnalysisExportData,
  parseGroupAnalysisResult,
  parseGroupAnalysisTermRows,
  validateAnalysisStageCurrency,
  type GroupAnalysisRowV2,
  validateGroupAnalysisRequest,
} from '../shared/group-analysis'
import {
  isBrainAssetId,
  isSubjectAssetId,
  type BrainAssetReadRequest,
  type BrainAssetsRequest,
} from '../shared/brain-atlas'
import {
  ANALYSIS_EXPORT_NAME,
  MAX_EXPORT_REQUEST_BYTES,
  boundedRequestBytes,
  chooseAnalysisExportFolder,
  parseAnalysisExportRequest,
  writeAnalysisExport,
  type AnalysisExportTerms,
} from './group-analysis-export'
import {
  listBrainAssets,
  readBrainAsset,
  type BrainAssetContext,
} from './brain-assets'
import log from 'electron-log'
import { autoUpdate } from './autoupdate'
import type { MachinePreferenceController } from './preferences'
import type { Sidecar, SidecarNotification } from './sidecar'
import { isAllowedWebDestination, type WebPurpose } from './web-destinations'
import {
  isWindowPlacementPreference,
  type WindowPlacementController,
} from './window-placement'

const PROJECT_FILE_NAME = 'supraspina.project.json'
const SUPRASPINA_DIR = '.supraspina'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
/**
 * The analysis requests that carry a specification or a measure list, and
 * their cap: a spec v2 may list 20,000 measures of up to 160 characters
 * (about 3.3 MB). With the project configuration (at most 2 MiB) main adds,
 * the sidecar request stays within its 8 MiB line.
 */
const LARGE_ANALYSIS_REQUESTS = new Set([
  'groupAnalysis.inputs',
  'groupAnalysis.start',
  'groupAnalysis.saveSpec',
  'groupAnalysis.saveSet',
])
const MAX_ANALYSIS_REQUEST_BYTES = 4 * 1024 * 1024
/** The largest CSV of measure IDs "Import set" reads. */
const MAX_ANALYSIS_SET_IMPORT_BYTES = 256 * 1024
/** The most atlas files one import names (a gcs, annot, or volume set). */
const MAX_ATLAS_IMPORT_FILES = 8
/** The labeling methods whose requests carry the machine-level tools. */
const MACHINE_TOOL_SIDECAR = new Set([
  'groupAnalysis.atlases',
  'groupAnalysis.labelStart',
])
const MAX_PROJECT_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_QC_STORE_BYTES = 16 * 1024 * 1024
const MAX_BOUNDED_READ_CHUNK_BYTES = 64 * 1024
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_QC_GALLERY_BYTES = 16 * 1024 * 1024
const MAX_LIST_ENTRIES = 1000
const MAX_DIRECTORY_SCAN_ENTRIES = 1000
const MAX_RUNTIME_JOB_EVIDENCE = 20_000
const MAX_ARTIFACT_GRANTS = 10_000
const MAX_DESTINATION_GRANTS = 128
const MAX_EXECUTION_GRANTS = 256
const MAX_QC_REVIEW_GRANTS = 10_000
const MAX_QC_AUTHORITY_RUNS = 100
const QC_AUTHORITY_PAGE_SIZE = 25
const DESTINATION_TTL_MS = 10 * 60 * 1000
const QC_REVIEW_GRANT_TTL_MS = 2 * 60 * 60 * 1000
/** A ceiling above the 16 panels, two PNGs each, of the largest montage. */
const MAX_QC_GALLERY_PANELS = 64
/** A bound on retained native montages, like every other main-issued capability. */
const MAX_QC_GALLERY_VIEWS = 64
const QC_GALLERY_VIEW_TTL_MS = 2 * 60 * 60 * 1000
/**
 * A bound on how long a cached gallery authority answer or run verdict is
 * reused. Events discard both sooner; this bounds changes no event reports,
 * such as outputs edited outside Supraspina.
 */
const QC_AUTHORITY_MEMO_MS = 5 * 60 * 1000

const NATIVE_METHODS = new Set<string>(surface.native)
const SIDECAR_METHODS = new Set<string>(surface.sidecar)

interface InvocationContext {
  senderId: number
}

interface LifecycleHooks {
  request(intent: BoundaryIntent): Promise<void>
  respond(request: {
    requestId: string
    decision: 'proceed' | 'cancel'
    reason?: string
  }): Promise<void>
}

interface HandlerServices {
  sidecar?: Pick<Sidecar, 'call' | 'getState' | 'retry' | 'setProjectAttached'>
  lifecycle?: LifecycleHooks
  artifactUseBarrier?: (path: string) => Promise<void>
  preferences?: MachinePreferenceController
  windowPlacement?: WindowPlacementController
  thirdPartyNoticesPath?: string
  /** Electron's userData root, so QC inventories sign like Results. */
  userDataPath?: string
  /** The atlas source manager; built over `userDataPath` when omitted. */
  atlasSources?: AtlasSourceManager
}

/** A native handler over positional arguments and trusted sender data. */
type NativeHandler = (
  args: unknown[],
  invocation?: InvocationContext,
) => Promise<unknown>

interface ProjectSession {
  ref: ProjectRef
  cfg: ProjectConfig
  configRevision: number
  configSha256: string
  savedSafeExecution: boolean
  allowedRoots: string[]
}

type DestinationPurpose =
  | 'subjects-csv'
  | 'debug-bundle'
  | 'registry-import-example'
  | 'analysis-export'

interface DestinationGrant {
  path: string
  ownerId: number
  purpose: DestinationPurpose
  projectId: string
  projectEpoch: number
  expiresAt: number
}

interface ExecutionGrant extends ExecutionAuthorization {
  ownerId: number
  projectEpoch: number
  expiresAt: number
}

interface ArtifactGrant {
  projectId: string
  epoch: number
  candidatePath: string
  exactPath?: boolean
  ownerId?: number
  metadata?: ResultArtifact
  inventoryRunId?: string
  inventoryConfigSha256?: string
}

interface QcReviewGrantRecord {
  grantId: string
  ownerId: number
  projectId: string
  projectEpoch: number
  configRevision: number
  configSha256: string
  subjectId: string
  artifactId: string
  tab: QcGalleryReviewEvidence['tab']
  label: string
  displayPath: string
  inventoryRunId: string
  inventoryConfigSha256: string
  runId: string
  receiptSha256: string
  path: string
  fileInfo: Stats
  fileSha256: string
  openedAt: string
  expiresAt: number
}

/**
 * One detector-verified PNG for a native QC montage. Preserve the detector's own
 * `bytes` and `sha256` values so the window payload can be checked against what
 * the detector accepted rather than merely against the path.
 */
interface QcGalleryImageRecord {
  ownerId: number
  projectId: string
  projectEpoch: number
  bytes: number
  sha256: string
  /** Set once `artifact.previewImage` has served these exact verified bytes. */
  displayed: boolean
}

/** One in-app montage requested for a subject and gallery. */
interface QcGalleryViewRecord {
  ownerId: number
  projectId: string
  projectEpoch: number
  configRevision: number
  configSha256: string
  subjectId: string
  tab: QcGalleryReviewEvidence['tab']
  galleryArtifactId: string
  inventoryRunId: string
  runId: string
  receiptSha256: string
  /** List every panel the grid draws and require all of them before attestation. */
  montageArtifactIds: string[]
  /** List the full-resolution companions so eviction releases their bytes too. */
  fullArtifactIds: string[]
  expiresAt: number
}

const projectSessions = new Map<string, ProjectSession>()
let activeProjectId: string | null = null
let highestAcceptedProjectEpoch = -1
const destinations = new Map<string, DestinationGrant>()
const artifacts = new Map<string, ArtifactGrant>()
const qcWriteChains = new Map<string, Promise<unknown>>()
const projectWriteChains = new Map<string, Promise<unknown>>()
const projectOperationChains = new Map<string, Promise<unknown>>()
const executionGrants = new Map<string, ExecutionGrant>()
const qcReviewGrants = new Map<string, QcReviewGrantRecord>()
const qcGalleryImages = new Map<string, QcGalleryImageRecord>()
const qcGalleryViews = new Map<string, QcGalleryViewRecord>()
const qcAuthorityMemo = new Map<
  string,
  { value: QcGallerySearch; expiresAt: number }
>()
const qcRunVerdicts = new Map<string, QcRunVerdictRecord>()
/** Advanced by every invalidation, so an answer computed across one is dropped. */
let qcAuthorityGeneration = 0
/** Advanced when run verdicts are forgotten, which changes inventory keys. */
let qcAuthorityResets = 0
const EXECUTION_GRANT_TTL_MS = 2 * 60 * 1000
const QC_GALLERY_LABELS = {
  subcortical: 'Subcortical QC gallery',
  internal: 'Cortical-internal QC gallery',
  external: 'Cortical-external QC gallery',
} as const
const QC_GALLERY_TABS = Object.keys(QC_GALLERY_LABELS) as Array<
  keyof typeof QC_GALLERY_LABELS
>
const RESULT_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  'csv',
  'png',
  'html',
  'xlsx',
  'txt',
  'nii',
  'pdf',
  'dir',
] satisfies Array<ResultArtifact['kind']>)
const RESULT_PRESENCE = new Set(['produced', 'partial', 'absent'])
const RESULT_PROVENANCE = new Set(['current', 'stale', 'unknown'])
const RECEIPT_DIGEST = /^[a-f0-9]{64}$/
const RUN_ID = /^run-[a-f0-9]{8,32}$/
const QC_FOCUS_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Report whether one byte can belong to a subject identifier. */
function isSubjectIdByte(byte: number | undefined): boolean {
  if (byte === undefined) return false
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x2d
  )
}

/**
 * Report whether a QC gallery names one subject as a whole identifier.
 *
 * A bare substring search lets a subject whose identifier is a prefix of
 * another one (`sub-01` inside `sub-011`) claim a panel it has none of, so
 * require every accepted occurrence to end at the buffer boundary or at a byte
 * that cannot belong to a subject identifier.
 *
 * @example
 * galleryNamesSubject(Buffer.from('<b>sub-011</b>'), 'sub-01') // false
 */
function galleryNamesSubject(gallery: Buffer, subjectId: string): boolean {
  const needle = Buffer.from(subjectId, 'utf8')
  if (needle.length === 0) return false
  for (
    let index = gallery.indexOf(needle);
    index !== -1;
    index = gallery.indexOf(needle, index + 1)
  ) {
    if (
      !isSubjectIdByte(gallery[index - 1]) &&
      !isSubjectIdByte(gallery[index + needle.length])
    ) {
      return true
    }
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`Correct the invalid fields in ${label}.`)
  }
}

function isSafeSegment(value: string): boolean {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  return (
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    !/[/\\]/.test(value) &&
    !hasControlCharacter
  )
}

const SUBJECT_COHORTS = new Set(['CTRL', 'SCI_nNP', 'SCI_P', 'UNKNOWN'])
const SUBJECT_SEXES = new Set(['M', 'F', 'O'])
const SUBJECT_AIS_GRADES = new Set(['A', 'B', 'C', 'D'])
const SUBJECT_QC = new Set(['pass', 'fail', 'defer'])
const SUBJECT_CELL_STATES = new Set([
  'pending',
  'planned',
  'waiting',
  'queued',
  'running',
  'cancelling',
  'done',
  'failed',
  'cancelled',
  'blocked',
  'withheld',
  'interrupted',
  'stale',
  'skipped',
])
const SUBJECT_STEP_KEYS = new Set<string>(STEP_KEYS)
const SUBJECT_ROLES = new Set([
  'healthy',
  'sci-no-neuropathic-pain',
  'sci-neuropathic-pain',
  'ambiguous',
])
const SUBJECT_T1_STATES = new Set(['available', 'missing', 'ambiguous'])

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** Validate one untrusted matrix cell, including every string/number field. */
function isSubjectCell(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.st === 'string' &&
    SUBJECT_CELL_STATES.has(value.st) &&
    isNullableFiniteNumber(value.startedAt) &&
    isNullableFiniteNumber(value.finishedAt) &&
    isNullableFiniteNumber(value.progress) &&
    isNullableFiniteNumber(value.rc) &&
    (value.err === null || typeof value.err === 'string')
  )
}

/** Validate one untrusted sidecar subject without JavaScript truthiness. */
function parseSubjectResult(value: unknown, key: string): Subject {
  if (!isRecord(value))
    throw new Error(`Reject the invalid subject returned by ${key}, and retry.`)
  const qc = value.qc
  if (
    typeof value.id !== 'string' ||
    !isSafeSegment(value.id) ||
    value.id.length > 128 ||
    !isNullableFiniteNumber(value.age) ||
    typeof value.registered !== 'boolean' ||
    typeof value.sex !== 'string' ||
    !SUBJECT_SEXES.has(value.sex) ||
    typeof value.cohort !== 'string' ||
    !SUBJECT_COHORTS.has(value.cohort) ||
    (value.ais !== null &&
      (typeof value.ais !== 'string' || !SUBJECT_AIS_GRADES.has(value.ais))) ||
    !isNullableFiniteNumber(value.tSinceSci) ||
    !Array.isArray(value.cells) ||
    value.cells.length !== MATRIX_STEPS.length ||
    !value.cells.every(isSubjectCell) ||
    (qc !== null && (typeof qc !== 'string' || !SUBJECT_QC.has(qc))) ||
    typeof value.notes !== 'string' ||
    typeof value.analysisEligible !== 'boolean'
  ) {
    throw new Error(`Reject the invalid subject returned by ${key}, and retry.`)
  }
  if (
    value.cohortRole !== undefined &&
    (typeof value.cohortRole !== 'string' ||
      !SUBJECT_ROLES.has(value.cohortRole))
  ) {
    throw new Error(
      `Retry ${key} after the runtime returns a valid subject role.`,
    )
  }
  if (
    value.stepStates !== undefined &&
    (!isRecord(value.stepStates) ||
      Object.entries(value.stepStates).some(
        ([step, state]) =>
          !SUBJECT_STEP_KEYS.has(step) ||
          typeof state !== 'string' ||
          !SUBJECT_CELL_STATES.has(state),
      ))
  ) {
    throw new Error(
      `Retry ${key} after the runtime returns valid subject step states.`,
    )
  }
  if (
    value.qcTags !== undefined &&
    (!Array.isArray(value.qcTags) ||
      value.qcTags.some((tag) => typeof tag !== 'string'))
  ) {
    throw new Error(`Retry ${key} after the runtime returns valid QC tags.`)
  }
  if (
    value.qcRevision !== undefined &&
    (!Number.isSafeInteger(value.qcRevision) || Number(value.qcRevision) < 0)
  ) {
    throw new Error(
      `Retry ${key} after the runtime returns a valid QC revision.`,
    )
  }
  if (
    value.sourceCohortLabel !== undefined &&
    typeof value.sourceCohortLabel !== 'string'
  ) {
    throw new Error(
      `Retry ${key} after the runtime returns a valid source cohort label.`,
    )
  }
  if (
    value.t1Availability !== undefined &&
    (typeof value.t1Availability !== 'string' ||
      !SUBJECT_T1_STATES.has(value.t1Availability))
  ) {
    throw new Error(
      `Retry ${key} after the runtime returns valid T1 availability.`,
    )
  }
  if (
    value.unavailableReason !== undefined &&
    value.unavailableReason !== null &&
    typeof value.unavailableReason !== 'string'
  ) {
    throw new Error(
      `Retry ${key} after the runtime returns a valid eligibility reason.`,
    )
  }
  if (
    value.site !== undefined &&
    value.site !== null &&
    !isSiteLabel(value.site)
  ) {
    throw new Error(`Retry ${key} after the runtime returns a valid site.`)
  }
  if (
    value.integrityErrors !== undefined &&
    (!Array.isArray(value.integrityErrors) ||
      value.integrityErrors.length > 64 ||
      value.integrityErrors.some(
        (detail) => typeof detail !== 'string' || detail.length > 512,
      ))
  ) {
    throw new Error(
      `Retry ${key} after the runtime returns valid integrity errors.`,
    )
  }
  return normalizeAnalysisEligibility(value as unknown as Subject)
}

/** Validate and normalize the two sidecar methods that publish Subject rows. */
function parseSubjectRpcResult(key: string, value: unknown): unknown {
  if (key === 'subjects.refreshOne') return parseSubjectResult(value, key)
  if (key !== 'subjects.discover') return value
  if (!Array.isArray(value)) {
    throw new Error(
      'Reject the invalid subject list returned by subjects.discover.',
    )
  }
  return value.map((subject) => parseSubjectResult(subject, key))
}

function parseInputFovListRpcResult(
  value: unknown,
  session: ProjectSession,
  ownerId: number,
): InputFovListResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 5_000
  ) {
    throw new Error('Return a valid result from inputFov.list.')
  }
  const artifactIds = new Set<string>()
  const grants: Array<{ artifactId: string; path: string }> = []
  const publicItems = value.items.map((item) => {
    if (!isRecord(item)) {
      throw new Error('Return a valid item from inputFov.list.')
    }
    const qcPath = item.qcPath
    const artifactId = item.qcArtifactId
    if (
      typeof qcPath !== 'string' ||
      !isAbsolute(qcPath) ||
      qcPath.length > 16_384 ||
      typeof artifactId !== 'string' ||
      artifactIds.has(artifactId)
    ) {
      throw new Error('Return valid montage evidence from inputFov.list.')
    }
    artifactIds.add(artifactId)
    const {
      qcPath: _hiddenQcPath,
      rawT1Path: _hiddenRawPath,
      preparedT1Path: _hiddenPreparedPath,
      ...publicItem
    } = item
    void _hiddenQcPath
    void _hiddenRawPath
    void _hiddenPreparedPath
    const parsed = parseInputFovListResult({
      configRevision: value.configRevision,
      items: [publicItem],
    }).items[0]
    if (!parsed) {
      throw new Error('Return a valid item from inputFov.list.')
    }
    grants.push({ artifactId: parsed.qcArtifactId, path: qcPath })
    return parsed
  })
  const parsed = parseInputFovListResult({
    configRevision: value.configRevision,
    items: publicItems,
  })
  for (const grant of grants) {
    registerArtifact(
      session,
      grant.artifactId,
      grant.path,
      undefined,
      false,
      ownerId,
    )
  }
  return parsed
}

function parseManagedOperationResult(value: unknown): {
  operationId: string
} {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.operationId !== 'string' ||
    !/^resource-[a-f0-9]{12}$/.test(value.operationId)
  ) {
    throw new Error('Provide a valid managed-resource operation result.')
  }
  return { operationId: value.operationId }
}

function parseManagedCancelResult(value: unknown): {
  operationId: string
  accepted: boolean
  terminal: boolean
} {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'accepted,operationId,terminal' ||
    typeof value.operationId !== 'string' ||
    !/^resource-[a-f0-9]{12}$/.test(value.operationId) ||
    typeof value.accepted !== 'boolean' ||
    typeof value.terminal !== 'boolean'
  ) {
    throw new Error('Provide a valid managed-resource cancellation result.')
  }
  return {
    operationId: value.operationId,
    accepted: value.accepted,
    terminal: value.terminal,
  }
}

function assertEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('Provide the project epoch as a non-negative safe integer.')
  }
  return Number(value)
}

function parseConfig(value: unknown, operation: string): ProjectConfig {
  const parsed = validateProjectConfig(value)
  if (!parsed.ok || parsed.data === null) {
    throw new Error(
      `Correct the ${operation} configuration: ${parsed.errors.join('; ')}.`,
    )
  }
  return parsed.data
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readRegularFileBounded(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<{ bytes: Buffer; info: Stats }> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const info = await handle.stat()
    if (!info.isFile()) {
      throw new Error(`Reject ${label} because it is not a regular file.`)
    }
    if (info.size > maximumBytes) {
      throw new Error(
        `Reject ${label} because it exceeds the bounded size limit.`,
      )
    }
    const chunks: Buffer[] = []
    let offset = 0
    while (offset <= maximumBytes) {
      const buffer = Buffer.alloc(
        Math.min(MAX_BOUNDED_READ_CHUNK_BYTES, maximumBytes + 1 - offset),
      )
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    if (offset > maximumBytes) {
      throw new Error(
        `Reject ${label} because it exceeds the bounded size limit.`,
      )
    }
    const finalInfo = await handle.stat()
    if (
      offset !== info.size ||
      finalInfo.size !== info.size ||
      finalInfo.mtimeMs !== info.mtimeMs ||
      finalInfo.ctimeMs !== info.ctimeMs
    ) {
      throw new Error(`Reject ${label} because it changed while being read.`)
    }
    return { bytes: Buffer.concat(chunks, offset), info }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readProjectConfigBytes(path: string): Promise<Buffer> {
  const { bytes } = await readRegularFileBounded(
    path,
    MAX_PROJECT_CONFIG_BYTES,
    'the project configuration',
  )
  return bytes
}

async function fsyncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch {
    // Tolerate platforms and filesystems that do not support directory fsync.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeBytesAtomic(
  target: string,
  bytes: Buffer,
  mode = 0o644,
): Promise<string> {
  const root = dirname(target)
  const tmp = join(
    root,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle
  try {
    handle = await open(tmp, 'wx', mode)
    await handle.writeFile(bytes)
    await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tmp, target)
    await fsyncDirectory(root)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  return sha256(bytes)
}

async function createBytesAtomic(
  target: string,
  bytes: Buffer,
): Promise<string> {
  const root = dirname(target)
  const tmp = join(
    root,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let handle
  try {
    handle = await open(tmp, 'wx', 0o644)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    // Publish complete bytes without replacing a concurrently created project.
    await link(tmp, target)
    await unlink(tmp)
    await fsyncDirectory(root)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  return sha256(bytes)
}

async function writeJsonAtomic(
  target: string,
  value: unknown,
): Promise<string> {
  return writeBytesAtomic(
    target,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  )
}

async function createJsonAtomic(
  target: string,
  value: unknown,
): Promise<string> {
  return createBytesAtomic(
    target,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  )
}

function projectIdFor(configPath: string): string {
  return `project-${createHash('sha256').update(configPath).digest('hex').slice(0, 24)}`
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  )
}

function concretePath(cfg: ProjectConfig, template: string): string | null {
  const value = resolveTemplate(template, flattenConfig(cfg))
  if (
    !value ||
    value.includes('${') ||
    !isAbsolute(value) ||
    /[\r\n\0]/.test(value)
  ) {
    return null
  }
  return resolve(value)
}

function allowedRootsFor(cfg: ProjectConfig, projectRoot: string): string[] {
  const roots = new Set<string>()
  const sensitiveRoots = [
    concretePath(cfg, '${paths.rawdataDir}'),
    concretePath(cfg, '${paths.metadataDir}'),
  ].filter((value): value is string => value !== null)
  for (const template of [
    '${paths.derivativesDir}',
    '${paths.outputDir}',
    '${paths.qcOutputDir}',
    '${outputs.rootDir}',
    '${outputs.runDir}',
  ]) {
    const value = concretePath(cfg, template)
    if (
      value &&
      !pathInside(value, projectRoot) &&
      !sensitiveRoots.some(
        (sensitive) =>
          pathInside(value, sensitive) || pathInside(sensitive, value),
      )
    ) {
      roots.add(value)
    }
  }
  return [...roots]
}

function registerProject(
  root: string,
  configPath: string,
  cfg: ProjectConfig,
  configSha256: string,
  epoch: number,
): ProjectOpenResult {
  if (epoch <= highestAcceptedProjectEpoch) {
    throw new Error('Retry with a fresh project boundary epoch.')
  }
  const ref: ProjectRef = {
    projectId: projectIdFor(configPath),
    root,
    configPath,
    epoch,
  }
  projectSessions.clear()
  destinations.clear()
  artifacts.clear()
  executionGrants.clear()
  qcReviewGrants.clear()
  qcGalleryViews.clear()
  qcGalleryImages.clear()
  invalidateQcAuthority('all')
  activeProjectId = ref.projectId
  highestAcceptedProjectEpoch = epoch
  projectSessions.set(ref.projectId, {
    ref,
    cfg,
    configRevision: 0,
    configSha256,
    savedSafeExecution: false,
    allowedRoots: allowedRootsFor(cfg, root),
  })
  return { project: ref, cfg, configSha256 }
}

function sameProjectRef(actual: ProjectRef, expected: ProjectRef): boolean {
  return (
    actual.projectId === expected.projectId &&
    actual.root === expected.root &&
    actual.configPath === expected.configPath &&
    actual.epoch === expected.epoch
  )
}

function requireProject(value: unknown): ProjectSession {
  if (!isRecord(value)) throw new Error('Provide the active project identity.')
  const candidate = value as unknown as ProjectRef
  const session = projectSessions.get(String(candidate.projectId ?? ''))
  if (
    !session ||
    session.ref.projectId !== activeProjectId ||
    !sameProjectRef(candidate, session.ref)
  ) {
    throw new Error(
      'Reopen the stale or unknown project identity before continuing.',
    )
  }
  return session
}

function stableConfig(cfg: ProjectConfig): string {
  return JSON.stringify(cfg)
}

function canonicalJson(value: unknown): string {
  const normalized = Array.isArray(value)
    ? value.map((item) => JSON.parse(canonicalJson(item)) as unknown)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            // Drop explicitly undefined own keys exactly as JSON.stringify does,
            // so the digest keeps mirroring the persisted bytes.
            .filter((key) => value[key] !== undefined)
            .sort()
            .map((key) => [key, JSON.parse(canonicalJson(value[key]))]),
        )
      : value
  return JSON.stringify(normalized).replace(
    /[^\x20-\x7e]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * Digest a parsed configuration canonically, as the sidecar's
 * `stable_digest` does; exported for the cross-language parity test.
 */
export function canonicalConfigSha256(cfg: ProjectConfig): string {
  return sha256(Buffer.from(canonicalJson(cfg), 'utf8'))
}

async function assertSavedSessionCurrent(
  session: ProjectSession,
): Promise<void> {
  const bytes = await readProjectConfigBytes(session.ref.configPath)
  if (sha256(bytes) !== session.configSha256) {
    throw new Error('Reopen the project because it changed on disk.')
  }
}

function serializeWrite<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve()
  const next = prior.catch(() => undefined).then(operation)
  chains.set(key, next)
  const cleanup = (): void => {
    if (chains.get(key) === next) chains.delete(key)
  }
  void next.then(cleanup, cleanup)
  return next
}

async function assertConfigRoot(
  cfg: ProjectConfig,
  expectedRoot: string,
): Promise<void> {
  const configured = cfg.paths.projectRoot
  if (!configured || !isAbsolute(configured) || configured.includes('${')) {
    throw new Error('Provide a concrete absolute path in paths.projectRoot.')
  }
  const lexical = resolve(configured)
  const canonical = await realpath(lexical).catch(() => lexical)
  if (canonical !== expectedRoot) {
    throw new Error('Select the directory named by the project configuration.')
  }
}

function clearActiveProject(): void {
  activeProjectId = null
  projectSessions.clear()
  destinations.clear()
  artifacts.clear()
  executionGrants.clear()
  qcReviewGrants.clear()
  qcGalleryViews.clear()
  qcGalleryImages.clear()
  invalidateQcAuthority('all')
}

async function detachSession(
  session: ProjectSession,
  sidecar?: Pick<Sidecar, 'call' | 'getState' | 'setProjectAttached'>,
): Promise<void> {
  if (!sidecar || sidecar.getState().state !== 'ready') return
  const result = await sidecar.call('system.detachProject', [
    { project: session.ref },
  ])
  if (!isRecord(result) || typeof result.projectAttached !== 'boolean') {
    throw new Error(
      'Return a valid project detach result from the scientific runtime.',
    )
  }
  sidecar.setProjectAttached(result.projectAttached)
}

async function invalidateActiveProjectNow(
  sidecar?: Pick<Sidecar, 'call' | 'getState' | 'setProjectAttached'>,
  expectedProject?: unknown,
): Promise<void> {
  const session = activeProjectId
    ? projectSessions.get(activeProjectId)
    : undefined
  if (!session) {
    clearActiveProject()
    sidecar?.setProjectAttached(false)
    return
  }
  if (expectedProject !== undefined) requireProject(expectedProject)
  await detachSession(session, sidecar)
  clearActiveProject()
  sidecar?.setProjectAttached(false)
}

/**
 * Revoke project authority in the same queue as create, open, and save boundaries.
 *
 * @returns Resolves after detaching and clearing active project authority.
 * @throws When project validation or runtime detachment fails.
 */
export function invalidateActiveProject(
  sidecar?: Pick<Sidecar, 'call' | 'getState' | 'setProjectAttached'>,
  expectedProject?: unknown,
): Promise<void> {
  return serializeWrite(projectOperationChains, 'global-project-boundary', () =>
    invalidateActiveProjectNow(sidecar, expectedProject),
  )
}

async function createProject(
  request: unknown,
  sidecar?: Pick<Sidecar, 'call' | 'getState' | 'setProjectAttached'>,
): Promise<ProjectOpenResult> {
  if (!isRecord(request))
    throw new Error('Provide a valid project.create request.')
  const epoch = assertEpoch(request.epoch)
  if (epoch <= highestAcceptedProjectEpoch) {
    throw new Error('Retry with a fresh project boundary epoch.')
  }
  const at = String(request.at ?? '')
  if (!isAbsolute(at) || at.includes('${') || /[\r\n\0]/.test(at)) {
    throw new Error('Choose a concrete absolute directory for project.create.')
  }
  const cfg = parseConfig(request.cfg, 'project.create')
  const lexicalRoot = resolve(at)
  if (resolve(cfg.paths.projectRoot) !== lexicalRoot) {
    throw new Error(
      'Match the project.create target to the configured project root.',
    )
  }
  await mkdir(lexicalRoot, { recursive: true })
  const root = await realpath(lexicalRoot)
  await assertConfigRoot(cfg, root)
  const configPath = join(root, PROJECT_FILE_NAME)
  if (existsSync(configPath)) {
    throw new Error(
      'Choose a new project location without an existing supraspina.project.json.',
    )
  }
  // Detach before publishing the project file. A runtime that refuses to
  // detach while work is live rejects the create, and a config left at the
  // new location would block every retry on the existing-file guard above.
  const prior = activeProjectId
    ? projectSessions.get(activeProjectId)
    : undefined
  if (prior) await detachSession(prior, sidecar)
  const configSha256 = await createJsonAtomic(configPath, cfg)
  return registerProject(root, configPath, cfg, configSha256, epoch)
}

async function openProject(
  request: unknown,
  sidecar?: Pick<Sidecar, 'call' | 'getState' | 'setProjectAttached'>,
): Promise<ProjectOpenResult> {
  if (!isRecord(request))
    throw new Error('Provide a valid project.open request.')
  const epoch = assertEpoch(request.epoch)
  if (epoch <= highestAcceptedProjectEpoch) {
    throw new Error('Retry with a fresh project boundary epoch.')
  }
  const requested = String(request.path ?? '')
  if (!requested || !isAbsolute(requested) || /[\r\n\0]/.test(requested)) {
    throw new Error(
      'Provide an absolute project file or directory for project.open.',
    )
  }
  const selected = resolve(requested)
  const configCandidate =
    basename(selected) === PROJECT_FILE_NAME
      ? selected
      : join(selected, PROJECT_FILE_NAME)
  const configPath = await realpath(configCandidate)
  if (basename(configPath) !== PROJECT_FILE_NAME) {
    throw new Error(
      'Select supraspina.project.json or its containing directory.',
    )
  }
  const root = await realpath(dirname(configPath))
  const bytes = await readProjectConfigBytes(configPath)
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Select a project file that contains valid JSON.')
  }
  const cfg = parseConfig(raw, 'project.open')
  await assertConfigRoot(cfg, root)
  const prior = activeProjectId
    ? projectSessions.get(activeProjectId)
    : undefined
  if (prior) await detachSession(prior, sidecar)
  return registerProject(root, configPath, cfg, sha256(bytes), epoch)
}

async function saveProject(request: unknown): Promise<ProjectSaveResult> {
  if (!isRecord(request))
    throw new Error('Provide a valid project.save request.')
  const typed = request as unknown as ProjectSaveRequest
  const session = requireProject(typed.project)
  if (!Number.isSafeInteger(typed.configRevision) || typed.configRevision < 0) {
    throw new Error('Provide a non-negative configRevision for project.save.')
  }
  if (typeof typed.safeExecution !== 'boolean') {
    throw new Error('Provide a valid project.save safeExecution posture.')
  }
  if (!/^[a-f0-9]{64}$/.test(typed.expectedSha256)) {
    throw new Error('Provide a valid project.save expectedSha256.')
  }
  const cfg = parseConfig(typed.cfg, 'project.save')
  await assertConfigRoot(cfg, session.ref.root)
  return serializeWrite(projectWriteChains, session.ref.projectId, async () => {
    const currentBytes = await readProjectConfigBytes(session.ref.configPath)
    const currentSha = sha256(currentBytes)
    if (
      currentSha !== typed.expectedSha256 ||
      session.configSha256 !== typed.expectedSha256
    ) {
      throw new Error(
        'Reopen the project because it changed on disk before saving.',
      )
    }
    if (typed.configRevision < session.configRevision) {
      throw new Error(
        'Refresh the project before saving a stale config revision.',
      )
    }
    if (
      typed.configRevision === session.configRevision &&
      (stableConfig(cfg) !== stableConfig(session.cfg) ||
        typed.safeExecution !== session.savedSafeExecution)
    ) {
      throw new Error(
        'Advance configRevision when changing configuration or execution posture.',
      )
    }
    const nextSha = await writeJsonAtomic(session.ref.configPath, cfg)
    session.cfg = cfg
    session.configRevision = typed.configRevision
    session.configSha256 = nextSha
    session.savedSafeExecution = typed.safeExecution
    session.allowedRoots = allowedRootsFor(cfg, session.ref.root)
    for (const [token, grant] of executionGrants) {
      if (grant.projectId === session.ref.projectId)
        executionGrants.delete(token)
    }
    for (const [token, grant] of qcReviewGrants) {
      if (grant.projectId === session.ref.projectId)
        qcReviewGrants.delete(token)
    }
    invalidateQcAuthority('all')
    return {
      project: session.ref,
      configRevision: typed.configRevision,
      sha256: nextSha,
    }
  })
}

function registerDestination(
  path: string,
  ownerId: number,
  purpose: DestinationPurpose,
  session: ProjectSession,
): SaveDestination {
  for (const [id, grant] of destinations) {
    if (grant.expiresAt < Date.now()) destinations.delete(id)
  }
  while (destinations.size >= MAX_DESTINATION_GRANTS) {
    const oldest = destinations.keys().next().value as string | undefined
    if (oldest === undefined) break
    destinations.delete(oldest)
  }
  const destinationId = randomUUID()
  destinations.set(destinationId, {
    path,
    ownerId,
    purpose,
    projectId: session.ref.projectId,
    projectEpoch: session.ref.epoch,
    expiresAt: Date.now() + DESTINATION_TTL_MS,
  })
  return { destinationId, displayPath: path }
}

async function consumeDestination(
  destinationId: unknown,
  ownerId: number,
  purpose: DestinationPurpose,
  session: ProjectSession,
): Promise<string> {
  const id = String(destinationId ?? '')
  const grant = destinations.get(id)
  if (
    !grant ||
    grant.ownerId !== ownerId ||
    grant.purpose !== purpose ||
    grant.projectId !== session.ref.projectId ||
    grant.projectEpoch !== session.ref.epoch ||
    grant.expiresAt < Date.now()
  ) {
    // Discard only a grant that can never be used again. Burning a mismatched
    // one would destroy a destination the correct caller still holds.
    if (grant && grant.expiresAt < Date.now()) destinations.delete(id)
    throw new Error(
      'Provide an unused, unexpired save destination owned by this window.',
    )
  }
  destinations.delete(id)
  if (!isAbsolute(grant.path) || /[\r\n\0]/.test(grant.path)) {
    throw new Error('Provide a valid save destination.')
  }
  const parent = await realpath(dirname(grant.path))
  const target = join(parent, basename(grant.path))
  const existing = await lstat(target).catch(() => null)
  if (existing?.isSymbolicLink())
    throw new Error('Do not use a symlink as the save destination.')
  return target
}

const EXECUTION_PURPOSES = new Set<ExecutionAuthorization['purpose']>([
  'live-workflow',
  'provision',
  'opt-in-install',
  'cleanup',
])

async function authorizeExecution(
  request: unknown,
  ownerId: number,
): Promise<ExecutionAuthorization> {
  if (!isRecord(request))
    throw new Error('Provide a valid execution authorization request.')
  const session = requireProject(request.project)
  const purpose = request.purpose as ExecutionAuthorization['purpose']
  if (!EXECUTION_PURPOSES.has(purpose)) {
    throw new Error('Provide a valid execution authorization purpose.')
  }
  if (request.configRevision !== session.configRevision) {
    throw new Error(
      'Save the current configuration revision before authorizing execution.',
    )
  }
  if (!session.savedSafeExecution) {
    throw new Error(
      'Turn on and save Allow live runs before authorizing execution.',
    )
  }
  const workflowPurpose = purpose === 'live-workflow' || purpose === 'cleanup'
  const planDigest = request.planDigest
  if (
    workflowPurpose &&
    (typeof planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(planDigest))
  ) {
    throw new Error(
      'Provide the exact plan digest before authorizing workflow execution.',
    )
  }
  if (!workflowPurpose && planDigest !== undefined) {
    throw new Error(
      'Remove the plan digest from non-workflow execution authorization.',
    )
  }
  const authorizedRevision = session.configRevision
  await assertSavedSessionCurrent(session)
  const current = projectSessions.get(session.ref.projectId)
  if (
    activeProjectId !== session.ref.projectId ||
    current !== session ||
    !session.savedSafeExecution ||
    session.configRevision !== authorizedRevision
  ) {
    throw new Error(
      'Request a new execution authorization after checking the saved project.',
    )
  }
  const token = randomUUID()
  const authorization: ExecutionAuthorization = {
    token,
    projectId: session.ref.projectId,
    configRevision: authorizedRevision,
    purpose,
    ...(workflowPurpose ? { planDigest: String(planDigest) } : {}),
  }
  for (const [id, grant] of executionGrants) {
    if (grant.expiresAt < Date.now()) executionGrants.delete(id)
  }
  while (executionGrants.size >= MAX_EXECUTION_GRANTS) {
    const oldest = executionGrants.keys().next().value as string | undefined
    if (oldest === undefined) break
    executionGrants.delete(oldest)
  }
  executionGrants.set(token, {
    ...authorization,
    ownerId,
    projectEpoch: session.ref.epoch,
    expiresAt: Date.now() + EXECUTION_GRANT_TTL_MS,
  })
  return authorization
}

async function consumeExecutionAuthorization(
  value: unknown,
  expectedPurpose: ExecutionAuthorization['purpose'],
  session: ProjectSession,
  ownerId: number,
  expectedPlanDigest?: unknown,
): Promise<void> {
  if (!isRecord(value))
    throw new Error('Provide a one-use execution authorization.')
  const token = String(value.token ?? '')
  const grant = executionGrants.get(token)
  executionGrants.delete(token)
  const workflowPurpose =
    expectedPurpose === 'live-workflow' || expectedPurpose === 'cleanup'
  if (
    !grant ||
    grant.ownerId !== ownerId ||
    grant.projectId !== session.ref.projectId ||
    grant.projectEpoch !== session.ref.epoch ||
    grant.configRevision !== session.configRevision ||
    grant.purpose !== expectedPurpose ||
    grant.expiresAt < Date.now() ||
    value.projectId !== grant.projectId ||
    value.configRevision !== grant.configRevision ||
    value.purpose !== grant.purpose ||
    (workflowPurpose &&
      (typeof expectedPlanDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(expectedPlanDigest) ||
        grant.planDigest !== expectedPlanDigest ||
        value.planDigest !== expectedPlanDigest))
  ) {
    throw new Error('Request a fresh matching execution authorization.')
  }
  if (!session.savedSafeExecution) {
    throw new Error(
      'Save the Allow live runs setting before authorizing execution.',
    )
  }
  await assertSavedSessionCurrent(session)
  const current = projectSessions.get(session.ref.projectId)
  if (
    activeProjectId !== session.ref.projectId ||
    current !== session ||
    !session.savedSafeExecution ||
    session.configRevision !== grant.configRevision
  ) {
    throw new Error(
      'Request a new execution authorization after checking the saved project.',
    )
  }
}

function artifactKey(projectId: string, artifactId: string): string {
  return `${projectId}\u0000${artifactId}`
}

function registerArtifact(
  session: ProjectSession,
  artifactId: string,
  candidatePath: string,
  metadata?: ResultArtifact,
  exactPath = false,
  ownerId?: number,
): void {
  if (!artifactId || artifactId.length > 256 || !isAbsolute(candidatePath))
    return
  while (artifacts.size >= MAX_ARTIFACT_GRANTS) {
    const oldest = artifacts.keys().next().value as string | undefined
    if (oldest === undefined) break
    artifacts.delete(oldest)
  }
  artifacts.set(artifactKey(session.ref.projectId, artifactId), {
    projectId: session.ref.projectId,
    epoch: session.ref.epoch,
    candidatePath: resolve(candidatePath),
    ...(exactPath ? { exactPath: true } : {}),
    ...(ownerId !== undefined ? { ownerId } : {}),
    ...(metadata ? { metadata } : {}),
  })
}

/**
 * Decide whether one artifact path is covered by the active grants.
 *
 * A path inside an allowed output root is always covered. A path outside every
 * root is covered only when it is exactly the path an exact-path grant names,
 * which is how a consumed one-use debug-bundle destination stays reachable.
 */
export function artifactPathGranted(
  lexicalPath: string,
  allowedRoots: readonly string[],
  grantedExactPath: string | null,
): boolean {
  if (allowedRoots.some((root) => pathInside(root, lexicalPath))) return true
  return grantedExactPath !== null && lexicalPath === resolve(grantedExactPath)
}

async function validateArtifactPath(
  session: ProjectSession,
  candidatePath: string,
  extraRoots: string[] = [],
  grantedExactPath: string | null = null,
): Promise<{ path: string; info: Stats }> {
  requireProject(session.ref)
  const lexical = resolve(candidatePath)
  const allowedRoots = [
    ...session.allowedRoots,
    ...extraRoots.map((root) => resolve(root)),
  ]
  const allowExactPath =
    grantedExactPath !== null && lexical === resolve(grantedExactPath)
  if (!artifactPathGranted(lexical, allowedRoots, grantedExactPath)) {
    throw new Error('Open artifacts only from active project output roots.')
  }
  const direct = await lstat(lexical)
  if (direct.isSymbolicLink())
    throw new Error('Open the artifact through a non-symlink path.')
  const canonical = await realpath(lexical)
  const canonicalRoots = await Promise.all(
    allowedRoots.map((root) => realpath(root).catch(() => resolve(root))),
  )
  const sensitiveRoots = [
    concretePath(session.cfg, '${paths.rawdataDir}'),
    concretePath(session.cfg, '${paths.metadataDir}'),
  ].filter((value): value is string => value !== null)
  const canonicalSensitiveRoots = await Promise.all(
    sensitiveRoots.map((root) => realpath(root).catch(() => resolve(root))),
  )
  const safeCanonicalRoots = canonicalRoots.filter(
    (root) =>
      !pathInside(root, session.ref.root) &&
      !canonicalSensitiveRoots.some(
        (sensitive) =>
          pathInside(root, sensitive) || pathInside(sensitive, root),
      ),
  )
  if (
    !safeCanonicalRoots.some((root) => pathInside(root, canonical)) &&
    !(allowExactPath && canonical === lexical)
  ) {
    throw new Error(
      'Keep the artifact real path within active project output roots.',
    )
  }
  const info = await stat(canonical)
  requireProject(session.ref)
  return { path: canonical, info }
}

interface ArtifactLease {
  handle: FileHandle
  info: Stats
}

interface IssuedResultMetadata {
  artifact: ResultArtifact
  inventoryRunId: string | null
  configSha256: string
}

/** Parse immutable artifact attribution returned directly by the sidecar. */
function parseIssuedResultMetadata(
  value: unknown,
  artifactId: string,
  exists: boolean,
  filesystemKind: 'file' | 'directory',
): IssuedResultMetadata | null {
  if (value === undefined) return null
  if (!isRecord(value)) {
    throw new Error('Return valid metadata from the artifact resolver.')
  }
  assertExactObjectKeys(
    value,
    [
      'artifactId',
      'label',
      'stepKey',
      'subjectId',
      'kind',
      'presence',
      'displayPath',
      'runId',
      'producerNodeId',
      'receiptSha256',
      'provenance',
      'inventoryRunId',
      'configSha256',
    ],
    'artifact resolver metadata',
  )
  const subjectId = value.subjectId
  const runId = value.runId
  const producerNodeId = value.producerNodeId
  const receiptSha256 = value.receiptSha256
  const inventoryRunId = value.inventoryRunId
  const configSha256 = value.configSha256
  if (
    value.artifactId !== artifactId ||
    typeof value.label !== 'string' ||
    value.label.length === 0 ||
    value.label.length > 512 ||
    typeof value.stepKey !== 'string' ||
    !STEP_KEYS.includes(value.stepKey as StepKey) ||
    (subjectId !== null &&
      (typeof subjectId !== 'string' ||
        !isSafeSegment(subjectId) ||
        subjectId.length > 128)) ||
    typeof value.kind !== 'string' ||
    !RESULT_ARTIFACT_KINDS.has(value.kind) ||
    typeof value.presence !== 'string' ||
    !RESULT_PRESENCE.has(value.presence) ||
    typeof value.displayPath !== 'string' ||
    value.displayPath.length === 0 ||
    value.displayPath.length > 16_384 ||
    (runId !== null &&
      (typeof runId !== 'string' ||
        runId.length === 0 ||
        runId.length > 256)) ||
    (producerNodeId !== null &&
      (typeof producerNodeId !== 'string' || producerNodeId.length > 512)) ||
    (receiptSha256 !== null &&
      (typeof receiptSha256 !== 'string' ||
        !RECEIPT_DIGEST.test(receiptSha256))) ||
    typeof value.provenance !== 'string' ||
    !RESULT_PROVENANCE.has(value.provenance) ||
    (inventoryRunId !== null &&
      (typeof inventoryRunId !== 'string' ||
        inventoryRunId.length === 0 ||
        inventoryRunId.length > 256)) ||
    typeof configSha256 !== 'string' ||
    !RECEIPT_DIGEST.test(configSha256)
  ) {
    throw new Error('Return valid metadata from the artifact resolver.')
  }
  return {
    artifact: {
      artifactId,
      label: value.label,
      stepKey: value.stepKey as StepKey,
      subjectId: subjectId as string | null,
      kind: value.kind as ResultArtifact['kind'],
      presence: value.presence as ResultArtifact['presence'],
      displayPath: value.displayPath,
      exists,
      openable: exists && filesystemKind === 'file',
      revealable: exists,
      runId: runId as string | null,
      producerNodeId: producerNodeId as string | null,
      receiptSha256: receiptSha256 as string | null,
      provenance: value.provenance as ResultArtifact['provenance'],
    },
    inventoryRunId: inventoryRunId as string | null,
    configSha256,
  }
}

function sameFileIdentity(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino
}

async function openArtifactLease(
  path: string,
  expected: Stats,
  kind: 'file' | 'directory',
): Promise<ArtifactLease> {
  const typeFlag = kind === 'directory' ? constants.O_DIRECTORY : 0
  const closeOnExec =
    (constants as unknown as Record<string, number>)['O_CLOEXEC'] ?? 0
  const flags =
    constants.O_RDONLY | closeOnExec | constants.O_NOFOLLOW | typeFlag
  let handle: FileHandle
  try {
    handle = await open(path, flags)
  } catch {
    throw new Error(
      'Refresh Results because the artifact changed after validation.',
    )
  }
  try {
    const info = await handle.stat()
    const correctKind = kind === 'file' ? info.isFile() : info.isDirectory()
    if (!correctKind || !sameFileIdentity(expected, info)) {
      throw new Error(
        'Refresh Results because the artifact changed after validation.',
      )
    }
    return { handle, info }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function revalidateArtifactLease(
  resolved: Awaited<ReturnType<typeof resolveArtifactGrant>>,
  lease: ArtifactLease,
): Promise<string> {
  const latest = await validateArtifactPath(
    resolved.session,
    resolved.path,
    [],
    resolved.grant.exactPath === true ? resolved.grant.candidatePath : null,
  )
  if (!sameFileIdentity(lease.info, latest.info)) {
    throw new Error(
      'Refresh Results because the artifact changed after validation.',
    )
  }
  return latest.path
}

async function resolveArtifactGrant(
  request: unknown,
  sidecar?: Pick<Sidecar, 'call'>,
  ownerId?: number,
): Promise<{
  session: ProjectSession
  grant: ArtifactGrant
  path: string
  info: Stats
}> {
  if (!isRecord(request)) throw new Error('Provide a valid artifact request.')
  const session = requireProject(request.project)
  const artifactId = String(request.artifactId ?? '')
  if (!artifactId || artifactId.length > 256)
    throw new Error('Provide a valid artifact identity.')
  let grant = artifacts.get(artifactKey(session.ref.projectId, artifactId))
  let assertedKind: 'file' | 'directory' | null = null
  if (!grant) {
    if (!sidecar) throw new Error('Make the artifact resolver available.')
    const result = await sidecar.call('results.resolveArtifact', [
      { project: session.ref, artifactId },
    ])
    if (!isRecord(result) || result.exists !== true) {
      throw new Error('Refresh Results because the artifact no longer exists.')
    }
    const candidatePath = String(result.path ?? '')
    assertedKind =
      result.kind === 'file' || result.kind === 'directory' ? result.kind : null
    if (!assertedKind || !isAbsolute(candidatePath)) {
      throw new Error('Return valid evidence from the artifact resolver.')
    }
    const metadata = parseIssuedResultMetadata(
      result.metadata,
      artifactId,
      true,
      assertedKind,
    )
    grant = {
      projectId: session.ref.projectId,
      epoch: session.ref.epoch,
      candidatePath,
      ...(metadata ? { metadata: metadata.artifact } : {}),
      ...(metadata?.inventoryRunId
        ? { inventoryRunId: metadata.inventoryRunId }
        : {}),
      ...(metadata?.configSha256
        ? { inventoryConfigSha256: metadata.configSha256 }
        : {}),
    }
  }
  if (grant.epoch !== session.ref.epoch) {
    throw new Error('Refresh Results because the artifact identity is stale.')
  }
  if (grant.ownerId !== undefined && grant.ownerId !== ownerId) {
    throw new Error('Return to the window that registered this artifact.')
  }
  const validated = await validateArtifactPath(
    session,
    grant.candidatePath,
    [],
    grant.exactPath === true ? grant.candidatePath : null,
  )
  if (
    (assertedKind === 'file' && !validated.info.isFile()) ||
    (assertedKind === 'directory' && !validated.info.isDirectory())
  ) {
    throw new Error('Refresh Results because the artifact type changed.')
  }
  return { session, grant, ...validated }
}

function clampLimit(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.trunc(value)))
    : fallback
}

function kindFor(path: string): ResultArtifact['kind'] {
  switch (extname(path).toLowerCase()) {
    case '.csv':
      return 'csv'
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
      return 'png'
    case '.html':
    case '.htm':
      return 'html'
    case '.xlsx':
      return 'xlsx'
    case '.pdf':
      return 'pdf'
    case '.nii':
    case '.gz':
      return 'nii'
    default:
      return 'txt'
  }
}

async function listArtifact(
  request: unknown,
  sidecar?: Pick<Sidecar, 'call'>,
  ownerId?: number,
): Promise<ResultPage> {
  const resolved = await resolveArtifactGrant(request, sidecar, ownerId)
  if (!resolved.info.isDirectory())
    throw new Error('Select a directory artifact before listing it.')
  const typed = request as { cursor?: unknown; limit?: unknown }
  const parsedOffset = Number.parseInt(String(typed.cursor ?? '0'), 10)
  const offset =
    Number.isSafeInteger(parsedOffset) && parsedOffset >= 0
      ? Math.min(parsedOffset, MAX_DIRECTORY_SCAN_ENTRIES)
      : 0
  const limit = clampLimit(typed.limit, 100, MAX_LIST_ENTRIES)
  const entries: string[] = []
  let scanned = 0
  let scanTruncated = false
  const lease = await openArtifactLease(
    resolved.path,
    resolved.info,
    'directory',
  )
  try {
    const descriptorPath = `/proc/self/fd/${lease.handle.fd}`
    const directoryPath = existsSync(descriptorPath)
      ? descriptorPath
      : await revalidateArtifactLease(resolved, lease)
    const directory = await opendir(directoryPath)
    for await (const entry of directory) {
      scanned += 1
      if (scanned > MAX_DIRECTORY_SCAN_ENTRIES) {
        scanTruncated = true
        break
      }
      if (entry.isFile()) entries.push(entry.name)
    }
  } finally {
    await lease.handle.close()
  }
  entries.sort((a, b) => a.localeCompare(b))
  const page = entries.slice(offset, offset + limit)
  const items: ResultArtifact[] = page.map((name) => {
    const path = join(resolved.path, name)
    const artifactId = randomUUID()
    const parent = resolved.grant.metadata
    // No step declared these children, so the parent receipt does not cover
    // them. Carry the parent's step and subject for display only and leave
    // the run, producer, receipt, and provenance unclaimed.
    const item: ResultArtifact = {
      artifactId,
      label: name,
      stepKey: parent?.stepKey ?? ('final' as StepKey),
      subjectId: parent?.subjectId ?? null,
      kind: kindFor(path),
      presence: 'produced',
      displayPath: name,
      exists: true,
      openable: true,
      revealable: true,
      runId: null,
      producerNodeId: null,
      receiptSha256: null,
      provenance: 'unknown',
      provenanceDetails: null,
    }
    registerArtifact(resolved.session, artifactId, path, item, false, ownerId)
    return item
  })
  const next = offset + page.length
  return {
    items,
    nextCursor: next < entries.length ? String(next) : null,
    truncated: scanTruncated || next < entries.length,
  }
}

/**
 * Read at most `maxBytes` from a leased artifact.
 *
 * Size the buffer to the file the lease measured, not to the ceiling, so a QC
 * montage's dozen panels do not each allocate and zero the 8 MiB image bound.
 * Read one byte past the measured size to detect a file that outgrew its own
 * limit, which is what the `truncated` reports depend on.
 */
async function readBounded(
  lease: ArtifactLease,
  maxBytes: number,
): Promise<Buffer> {
  const wanted = Math.max(
    1,
    Math.min(maxBytes, Math.max(0, lease.info.size) + 1),
  )
  const buffer = Buffer.alloc(wanted)
  const { bytesRead } = await lease.handle.read(buffer, 0, wanted, 0)
  return buffer.subarray(0, bytesRead)
}

async function readArtifactText(
  request: unknown,
  sidecar?: Pick<Sidecar, 'call'>,
  ownerId?: number,
  beforeUse?: (path: string) => Promise<void>,
): Promise<ArtifactTextPreview> {
  const resolved = await resolveArtifactGrant(request, sidecar, ownerId)
  if (!resolved.info.isFile())
    throw new Error('Select a file artifact before reading it.')
  const maxBytes = clampLimit(
    isRecord(request) ? request.maxBytes : undefined,
    MAX_TEXT_BYTES,
    MAX_TEXT_BYTES,
  )
  await beforeUse?.(resolved.path)
  const lease = await openArtifactLease(resolved.path, resolved.info, 'file')
  try {
    const bytes = await readBounded(lease, maxBytes)
    return {
      text: bytes.toString('utf8'),
      truncated: lease.info.size > bytes.byteLength,
    }
  } finally {
    await lease.handle.close()
  }
}

async function previewArtifactImage(
  request: unknown,
  sidecar?: Pick<Sidecar, 'call'>,
  ownerId?: number,
): Promise<ArtifactImagePreview> {
  const resolved = await resolveArtifactGrant(request, sidecar, ownerId)
  if (!resolved.info.isFile())
    throw new Error('Select a file artifact before previewing it.')
  const ext = extname(resolved.path).toLowerCase()
  const mimeType =
    ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
          ? 'image/webp'
          : null
  if (mimeType === null)
    throw new Error('Select a supported PNG, JPEG, or WebP image.')
  // Show a QC montage image only as the detector verified it. Check the bytes
  // against the detector's size and digest.
  const verified = qcGalleryImages.get(
    artifactKey(
      resolved.session.ref.projectId,
      String(isRecord(request) ? (request.artifactId ?? '') : ''),
    ),
  )
  if (
    verified &&
    (verified.ownerId !== ownerId ||
      verified.projectEpoch !== resolved.session.ref.epoch)
  ) {
    throw new Error(
      'View the QC montage again because its image grant is stale.',
    )
  }
  const maxBytes = clampLimit(
    isRecord(request) ? request.maxBytes : undefined,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_BYTES,
  )
  if (resolved.info.size > maxBytes)
    throw new Error('Select an image within the preview size limit.')
  const lease = await openArtifactLease(resolved.path, resolved.info, 'file')
  try {
    if (lease.info.size > maxBytes)
      throw new Error('Select an image within the preview size limit.')
    const bytes = await readBounded(lease, maxBytes)
    if (verified) {
      if (
        lease.info.size !== verified.bytes ||
        bytes.byteLength !== verified.bytes ||
        sha256(bytes) !== verified.sha256
      ) {
        throw new Error(
          'View the QC montage again because its image changed after verification.',
        )
      }
      verified.displayed = true
    }
    return {
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      mimeType,
      truncated: false,
    }
  } finally {
    await lease.handle.close()
  }
}

async function newestSubjectLog(
  session: ProjectSession,
  sidecar: Pick<Sidecar, 'call'> | undefined,
  subject: string,
  step: string | null,
): Promise<string | null> {
  if (!sidecar) throw new Error('Make the scientific runtime available.')
  const snapshot = await sidecar.call('runtime.bootstrap', [
    { project: session.ref, runLimit: 200, logLimit: 0 },
  ])
  if (!isRecord(snapshot) || !Array.isArray(snapshot.jobs)) {
    throw new Error('Return valid log evidence from the scientific runtime.')
  }
  let best: { path: string; at: number } | null = null
  let inspected = 0
  for (const value of snapshot.jobs) {
    inspected += 1
    if (inspected > MAX_RUNTIME_JOB_EVIDENCE) break
    if (!isRecord(value)) continue
    if (
      value.projectId !== session.ref.projectId ||
      value.projectEpoch !== session.ref.epoch ||
      value.subjectId !== subject ||
      (step !== null && value.stepKey !== step) ||
      value.dryRun === true ||
      typeof value.stdoutPath !== 'string' ||
      !isAbsolute(value.stdoutPath)
    ) {
      continue
    }
    const at = [value.endedAt, value.startedAt, value.plannedAt].find(
      (candidate) =>
        typeof candidate === 'number' && Number.isFinite(candidate),
    )
    const timestamp = typeof at === 'number' ? at : 0
    if (best === null || timestamp > best.at) {
      best = { path: value.stdoutPath, at: timestamp }
    }
  }
  return best?.path ?? null
}

function csvCell(value: unknown): string {
  const raw = String(value ?? '')
  // Spreadsheets execute a cell that opens with one of these, so quote the
  // text into an inert literal before the separator escaping.
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Validate the renderer-supplied rows this export writes to disk. */
function parseSubjectExportRows(rows: unknown): Subject[] {
  if (!Array.isArray(rows)) {
    throw new Error('Provide the subject rows for the CSV export as a list.')
  }
  if (rows.length > MAX_LIST_ENTRIES) {
    throw new Error(`Export at most ${MAX_LIST_ENTRIES} subject rows.`)
  }
  return rows.map((row) => parseSubjectResult(row, 'subjects.exportCsv'))
}

function subjectsCsv(subjects: Subject[]): Buffer {
  const stepKeys = MATRIX_STEPS.map((step) => step.key)
  const lines = [
    [
      'id',
      'cohort',
      'age',
      'sex',
      'ais',
      'tSinceSci',
      'qc',
      'notes',
      ...stepKeys,
    ]
      .map(csvCell)
      .join(','),
  ]
  for (const subject of subjects) {
    const cells = stepKeys.map(
      (_key, index) => subject.cells?.[index]?.st ?? '',
    )
    lines.push(
      [
        subject.id,
        subject.cohort,
        subject.age ?? '',
        subject.sex,
        subject.ais ?? '',
        subject.tSinceSci ?? '',
        subject.qc ?? '',
        subject.notes ?? '',
        ...cells,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

async function markQc(
  request: unknown,
  verifier: QcAuthorityVerifier,
  ownerId: number,
): Promise<QcWriteResult> {
  if (!isRecord(request)) throw new Error('Provide a valid QC write request.')
  const typed = request as unknown as QcWriteRequest
  const session = requireProject(typed.project)
  if (!isValidQcSubjectId(typed.subjectId)) {
    throw new Error('Provide a valid QC subject ID.')
  }
  if (
    typed.verdict !== null &&
    typed.verdict !== 'pass' &&
    typed.verdict !== 'fail' &&
    typed.verdict !== 'defer'
  ) {
    throw new Error('Provide a valid QC verdict.')
  }
  if (
    !Array.isArray(typed.tags) ||
    typed.tags.some((tag) => typeof tag !== 'string')
  ) {
    throw new Error('Provide valid QC tags.')
  }
  if (
    typeof typed.note !== 'string' ||
    typed.note.length > MAX_QC_NOTE_LENGTH ||
    typed.tags.length > MAX_QC_TAGS ||
    typed.tags.some((tag) => tag.length > MAX_QC_TAG_LENGTH) ||
    (typed.expectedRevision !== undefined &&
      (!Number.isSafeInteger(typed.expectedRevision) ||
        typed.expectedRevision < 0))
  ) {
    throw new Error(
      'Shorten the QC note or tags to fit the bounded storage policy.',
    )
  }
  if (
    ('reviewEvidence' in request && request.reviewEvidence !== undefined) ||
    (typed.reviewGrantIds !== undefined &&
      (!Array.isArray(typed.reviewGrantIds) ||
        typed.reviewGrantIds.length !== 3 ||
        typed.reviewGrantIds.some(
          (grantId) =>
            typeof grantId !== 'string' || !/^[a-f0-9]{64}$/.test(grantId),
        ))) ||
    (typed.annotationOnly !== undefined &&
      typeof typed.annotationOnly !== 'boolean')
  ) {
    throw new Error('Provide a valid QC review grant request.')
  }
  const dir = join(session.ref.root, SUPRASPINA_DIR)
  const file = join(dir, 'qc_verdicts.json')
  return serializeWrite(qcWriteChains, file, async () => {
    requireProject(session.ref)
    let store: QcStoreDocument = emptyQcStore()
    let mode = 0o600
    try {
      const { bytes, info } = await readRegularFileBounded(
        file,
        MAX_QC_STORE_BYTES,
        'the QC verdict store',
      )
      mode = info.mode & 0o777
      const raw: unknown = JSON.parse(bytes.toString('utf8'))
      store = parseQcStore(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const current = store.verdicts[typed.subjectId]
    const currentRevision =
      current !== undefined && Number.isSafeInteger(current.revision)
        ? current.revision
        : 0
    if (
      typed.expectedRevision !== undefined &&
      typed.expectedRevision !== currentRevision
    ) {
      throw new Error(
        'Refresh the subject record before resolving the QC revision conflict.',
      )
    }
    // An annotation-only write keeps the saved verdict, which is null while
    // no record exists yet, so a reviewer can leave a note before reviewing.
    const savedVerdict = current?.verdict ?? null
    if (
      typed.annotationOnly === true &&
      (typed.verdict !== savedVerdict || typed.reviewGrantIds !== undefined)
    ) {
      throw new Error(
        'Preserve the saved verdict when updating a QC annotation.',
      )
    }
    const verdictNeedsFreshReview =
      typed.verdict !== null &&
      typed.annotationOnly !== true &&
      (typed.verdict !== current?.verdict ||
        current?.reviewEvidence === null ||
        typed.reviewGrantIds !== undefined)
    if (verdictNeedsFreshReview && typed.reviewGrantIds === undefined) {
      throw new Error(
        'Open all three current ENIGMA galleries before saving a QC verdict.',
      )
    }
    const validatedReview =
      typed.reviewGrantIds === undefined
        ? null
        : await validateQcReviewGrants(
            typed.reviewGrantIds,
            session,
            typed.subjectId,
            ownerId,
            verifier,
          )
    const reviewEvidence =
      typed.verdict === null
        ? null
        : (validatedReview?.evidence ?? current?.reviewEvidence ?? null)
    const result: QcWriteResult = {
      subjectId: typed.subjectId,
      verdict: typed.verdict,
      note: typeof typed.note === 'string' ? typed.note : '',
      tags: [...typed.tags],
      reviewEvidence,
      revision: currentRevision + 1,
      updatedAt: new Date().toISOString(),
    }
    store.verdicts[typed.subjectId] = {
      verdict: result.verdict,
      note: result.note,
      tags: result.tags,
      reviewEvidence,
      revision: result.revision,
      updatedAt: result.updatedAt,
    }
    await mkdir(dir, { recursive: true })
    requireProject(session.ref)
    await writeBytesAtomic(
      file,
      Buffer.from(`${JSON.stringify(store, null, 2)}\n`, 'utf8'),
      mode,
    )
    for (const grantId of validatedReview?.grantIds ?? []) {
      qcReviewGrants.delete(grantId)
    }
    return result
  })
}

function reviewerIdentity(): string {
  try {
    const username = userInfo().username.trim()
    if (
      username.length > 0 &&
      username.length <= 120 &&
      ![...username].some((character) => character.charCodeAt(0) < 0x20)
    ) {
      return `os-user:${username}`
    }
  } catch {
    // Prefer a bounded host-owned fallback to untrusted renderer input.
  }
  return 'os-user:unavailable'
}

function qcTabForLabel(label: string): QcGalleryReviewEvidence['tab'] | null {
  return QC_GALLERY_TABS.find((tab) => QC_GALLERY_LABELS[tab] === label) ?? null
}

function trustedQcArtifact(
  grant: ArtifactGrant,
  session: ProjectSession,
): {
  artifact: ResultArtifact
  tab: QcGalleryReviewEvidence['tab']
  inventoryRunId: string
  inventoryConfigSha256: string
  runId: string
  receiptSha256: string
} {
  const artifact = grant.metadata
  const tab = artifact ? qcTabForLabel(artifact.label) : null
  if (
    !artifact ||
    !tab ||
    artifact.stepKey !== 'enigma' ||
    artifact.subjectId !== null ||
    artifact.kind !== 'html' ||
    artifact.presence !== 'produced' ||
    !artifact.exists ||
    !artifact.openable ||
    artifact.provenance !== 'current' ||
    typeof artifact.runId !== 'string' ||
    !RUN_ID.test(artifact.runId) ||
    typeof artifact.receiptSha256 !== 'string' ||
    !RECEIPT_DIGEST.test(artifact.receiptSha256) ||
    typeof grant.inventoryRunId !== 'string' ||
    !RUN_ID.test(grant.inventoryRunId) ||
    typeof grant.inventoryConfigSha256 !== 'string' ||
    !RECEIPT_DIGEST.test(grant.inventoryConfigSha256) ||
    grant.inventoryConfigSha256 !== canonicalConfigSha256(session.cfg)
  ) {
    throw new Error(
      'Open a current detector-issued ENIGMA gallery before recording QC review.',
    )
  }
  return {
    artifact,
    tab,
    inventoryRunId: grant.inventoryRunId,
    inventoryConfigSha256: grant.inventoryConfigSha256,
    runId: artifact.runId,
    receiptSha256: artifact.receiptSha256,
  }
}

function issueQcReviewGrant(
  session: ProjectSession,
  ownerId: number,
  subjectId: string,
  artifactId: string,
  path: string,
  fileInfo: Stats,
  fileBytes: Buffer,
  attribution: ReturnType<typeof trustedQcArtifact>,
  openedAt: string,
): QcReviewOpenGrant {
  const now = Date.now()
  for (const [grantId, grant] of qcReviewGrants) {
    if (grant.expiresAt < now) qcReviewGrants.delete(grantId)
  }
  while (qcReviewGrants.size >= MAX_QC_REVIEW_GRANTS) {
    const oldest = qcReviewGrants.keys().next().value as string | undefined
    if (oldest === undefined) break
    qcReviewGrants.delete(oldest)
  }
  let grantId = randomBytes(32).toString('hex')
  while (qcReviewGrants.has(grantId)) {
    grantId = randomBytes(32).toString('hex')
  }
  const expiresAt = now + QC_REVIEW_GRANT_TTL_MS
  qcReviewGrants.set(grantId, {
    grantId,
    ownerId,
    projectId: session.ref.projectId,
    projectEpoch: session.ref.epoch,
    configRevision: session.configRevision,
    configSha256: session.configSha256,
    subjectId,
    artifactId,
    tab: attribution.tab,
    label: attribution.artifact.label,
    displayPath: attribution.artifact.displayPath,
    inventoryRunId: attribution.inventoryRunId,
    inventoryConfigSha256: attribution.inventoryConfigSha256,
    runId: attribution.runId,
    receiptSha256: attribution.receiptSha256,
    path,
    fileInfo,
    fileSha256: sha256(fileBytes),
    openedAt,
    expiresAt,
  })
  return {
    grantId,
    tab: attribution.tab,
    subjectId,
    inventoryRunId: attribution.inventoryRunId,
    runId: attribution.runId,
    receiptSha256: attribution.receiptSha256,
    openedAt,
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

interface CurrentQcGallery {
  tab: QcGalleryReviewEvidence['tab']
  label: string
  displayPath: string
  runId: string
  receiptSha256: string
}

function parseCurrentQcGallerySet(
  value: unknown,
  inventoryRunId: string,
): Map<QcGalleryReviewEvidence['tab'], CurrentQcGallery> {
  if (
    !isRecord(value) ||
    value.runId !== inventoryRunId ||
    !Array.isArray(value.items) ||
    value.truncated !== false ||
    value.nextCursor !== null
  ) {
    throw new Error('Open every current ENIGMA gallery before continuing.')
  }
  const galleries = new Map<QcGalleryReviewEvidence['tab'], CurrentQcGallery>()
  for (const item of value.items) {
    if (!isRecord(item) || typeof item.label !== 'string') continue
    const tab = qcTabForLabel(item.label)
    if (!tab) continue
    if (
      item.stepKey !== 'enigma' ||
      item.subjectId !== null ||
      item.kind !== 'html' ||
      item.presence !== 'produced' ||
      item.exists !== true ||
      item.openable !== true ||
      item.provenance !== 'current' ||
      typeof item.displayPath !== 'string' ||
      item.displayPath.length === 0 ||
      item.displayPath.length > 16_384 ||
      typeof item.runId !== 'string' ||
      !RUN_ID.test(item.runId) ||
      typeof item.receiptSha256 !== 'string' ||
      !RECEIPT_DIGEST.test(item.receiptSha256) ||
      galleries.has(tab)
    ) {
      throw new Error(
        'Reopen the current ENIGMA galleries because their evidence is inconsistent.',
      )
    }
    galleries.set(tab, {
      tab,
      label: item.label,
      displayPath: item.displayPath,
      runId: item.runId,
      receiptSha256: item.receiptSha256,
    })
  }
  if (
    galleries.size !== QC_GALLERY_TABS.length ||
    new Set([...galleries.values()].map((item) => item.runId)).size !== 1 ||
    new Set([...galleries.values()].map((item) => item.receiptSha256)).size !==
      1
  ) {
    throw new Error('Open every current ENIGMA gallery before continuing.')
  }
  return galleries
}

interface AuthoritativeQcGallerySet {
  inventoryRunId: string
  /** The run's recorded start time, which names the run in operator copy. */
  startedAt: string | null
  /** A token that changes whenever this run's gallery inventory may change. */
  inventoryKey: string
  galleries: Map<QcGalleryReviewEvidence['tab'], CurrentQcGallery>
}

/** The managed-resource runtime that main attaches to its own inventory calls. */
interface QcRuntimeContext {
  userDataPath: string
}

/**
 * The sidecar and trusted runtime context that resolve QC gallery authority.
 *
 * Sign main's own `results.list` calls with the runtime context that renderer
 * inventory requests receive. Without it the Brain FOV action binds as
 * unresolved, so every receipt downstream of it, ENIGMA QC included, reads as
 * stale while Results reads the same gallery as current.
 */
interface QcAuthorityVerifier {
  sidecar: Pick<Sidecar, 'call'> | undefined
  runtimeContext: QcRuntimeContext | null
}

/**
 * Build the trusted QC runtime context from Electron's userData root.
 *
 * @returns The context, or null for an absent or invalid path.
 */
function qcRuntimeContext(
  userDataPath: string | undefined,
): QcRuntimeContext | null {
  return typeof userDataPath === 'string' &&
    isAbsolute(userDataPath) &&
    userDataPath.length <= 16_384
    ? { userDataPath }
    : null
}

/** The analysis cohort one durable run manifest recorded. */
interface ManifestCohort {
  sha256: string
  subjectCount: number
}

/**
 * Why the newest run holding ENIGMA galleries cannot back new verdicts.
 *
 * `configChanged` means another saved configuration produced the galleries.
 * `stale` means the configuration matches but a gallery receipt no longer
 * matches its inputs. `unverifiable` means the inventory could not be read
 * completely or consistently; `detail` states why.
 */
type QcGalleryRejection =
  | { kind: 'configChanged' }
  | { kind: 'stale' }
  | { kind: 'unverifiable'; detail: string }

/** The newest run holding ENIGMA galleries that are not authoritative. */
interface EarlierQcGallerySet {
  inventoryRunId: string
  /** Whether its inventory showed a produced gallery for every tab. */
  holdsGalleries: boolean
  rejection: QcGalleryRejection
  cohort: ManifestCohort | null
}

/** One sweep's answer: the authority, or why the newest galleries are not. */
interface QcGallerySearch {
  authority: AuthoritativeQcGallerySet | null
  earlier: EarlierQcGallerySet | null
  /** The analysis cohort of the newest durable run that recorded one. */
  newestCohort: ManifestCohort | null
  /** Whether the answer may be reused; false after a transient inventory failure. */
  cacheable: boolean
}

/** Scope cached QC authority to one project, epoch, and saved configuration. */
function qcAuthorityScope(session: ProjectSession): string {
  return [
    session.ref.projectId,
    String(session.ref.epoch),
    String(session.configRevision),
    session.configSha256,
  ].join(' ')
}

/**
 * Forget cached QC authority after an event that can change it.
 *
 * Every invalidation discards the search answers and keeps an answer computed
 * across it out of the cache. Run activity keeps the per-run verdicts, whose
 * manifest fingerprints already detect a changed run; a sidecar, resource,
 * project, or configuration change forgets them too.
 *
 * @param extent - `all` also forgets the per-run verdicts.
 */
function invalidateQcAuthority(extent: 'answers' | 'all'): void {
  qcAuthorityGeneration += 1
  qcAuthorityMemo.clear()
  if (extent === 'all') {
    qcRunVerdicts.clear()
    qcAuthorityResets += 1
  }
}

/**
 * Keep one search answer unless an invalidation happened while it was computed.
 *
 * @param generation - The invalidation generation the search started in.
 */
function rememberQcGallerySearch(
  scope: string,
  generation: number,
  value: QcGallerySearch,
): void {
  if (!value.cacheable || generation !== qcAuthorityGeneration) return
  qcAuthorityMemo.clear()
  qcAuthorityMemo.set(scope, {
    value,
    expiresAt: Date.now() + QC_AUTHORITY_MEMO_MS,
  })
}

/**
 * Search for the authoritative gallery set, reusing the last answer.
 *
 * Finding it requires inspecting durable runs one by one, and QC review
 * otherwise repeats that sweep on every visit and every panel load. Keep a
 * missing authority too, so a repeat visit and a montage requested for a run
 * that is not authoritative both answer at once. Scope the answer to the exact
 * project, epoch, saved revision, and saved config digest; runtime
 * notifications, sidecar state changes, project boundaries, and config saves
 * discard it, and a TTL of minutes bounds any change nothing reports.
 *
 * Use this cache only on the display path. Observe the authoritative set
 * directly when minting review evidence, because being the newest qualifying
 * run is exactly what the grant attests.
 */
async function memoizedQcGallerySearch(
  verifier: QcAuthorityVerifier,
  session: ProjectSession,
): Promise<QcGallerySearch> {
  const scope = qcAuthorityScope(session)
  const hit = qcAuthorityMemo.get(scope)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  const generation = qcAuthorityGeneration
  const value = await searchQcGallerySets(verifier, session)
  rememberQcGallerySearch(scope, generation, value)
  return value
}

/**
 * The bounded operator-facing statement of the reviewed QC precondition.
 * Treat it as an expected answer, not as an unexpected failure.
 */
const QC_AUTHORITY_UNAVAILABLE_MESSAGE =
  'Run ENIGMA QC under the saved project configuration to review galleries.'

/**
 * Require the authoritative set from one search answer.
 *
 * @throws Error naming why no authoritative set exists.
 */
function requireQcAuthority(
  search: QcGallerySearch,
): AuthoritativeQcGallerySet {
  if (search.authority === null) {
    throw new Error(qcAuthorityUnavailable(search).message)
  }
  return search.authority
}

/**
 * Observe the authoritative set directly for minting review evidence.
 *
 * Always page the durable runs so a newer qualifying run is seen, reusing only
 * the verdicts of runs whose manifests are unchanged, and refresh the display
 * cache with the observed answer.
 */
async function authoritativeQcGallerySet(
  verifier: QcAuthorityVerifier,
  session: ProjectSession,
): Promise<AuthoritativeQcGallerySet> {
  const generation = qcAuthorityGeneration
  const search = await searchQcGallerySets(verifier, session)
  rememberQcGallerySearch(qcAuthorityScope(session), generation, search)
  return requireQcAuthority(search)
}

/**
 * Report whether one run manifest explicitly lists the ENIGMA QC stage.
 *
 * @returns True only for a stage list that includes ENIGMA QC.
 */
function manifestListsEnigma(manifest: Record<string, unknown>): boolean {
  const steps = manifest.steps
  return (
    Array.isArray(steps) &&
    steps.some((step) => isRecord(step) && String(step.key ?? '') === 'enigma')
  )
}

/**
 * Report whether one run manifest recorded the ENIGMA QC stage.
 *
 * @returns False only for a manifest that lists stages and omits it.
 */
function manifestDeclaresEnigma(manifest: Record<string, unknown>): boolean {
  const steps = manifest.steps
  // Treat an absent or unreadable stage list as unknown and keep inspecting,
  // so a manifest shape this build does not recognize never hides a gallery.
  if (!Array.isArray(steps) || steps.length === 0) return true
  return manifestListsEnigma(manifest)
}

/**
 * Select the cohort-level ENIGMA gallery rows of one inventory page.
 *
 * @param page - One `results.list` page for the ENIGMA stage.
 * @returns Each produced gallery row with its tab.
 */
function producedQcGalleries(
  page: Record<string, unknown>,
): Array<{ tab: QcGalleryReviewEvidence['tab']; provenance: unknown }> {
  if (!Array.isArray(page.items)) return []
  const galleries: Array<{
    tab: QcGalleryReviewEvidence['tab']
    provenance: unknown
  }> = []
  for (const item of page.items) {
    if (
      !isRecord(item) ||
      typeof item.label !== 'string' ||
      item.stepKey !== 'enigma' ||
      item.subjectId !== null ||
      item.kind !== 'html' ||
      item.presence !== 'produced' ||
      item.exists !== true
    ) {
      continue
    }
    const tab = qcTabForLabel(item.label)
    if (tab) galleries.push({ tab, provenance: item.provenance })
  }
  return galleries
}

/**
 * Report whether one ENIGMA inventory holds every produced gallery.
 *
 * This check ignores configuration and provenance on purpose: it only tells an
 * operator that galleries exist, never that they may back new verdicts.
 *
 * @param page - One `results.list` page for the ENIGMA stage.
 * @returns True when each QC gallery tab has a produced HTML artifact.
 */
function holdsProducedQcGallerySet(page: Record<string, unknown>): boolean {
  const tabs = new Set(producedQcGalleries(page).map((gallery) => gallery.tab))
  return tabs.size === QC_GALLERY_TABS.length
}

/**
 * Read the analysis cohort one durable run manifest recorded.
 *
 * @returns The cohort digest and size, or null when unrecorded.
 */
function manifestCohort(
  manifest: Record<string, unknown>,
): ManifestCohort | null {
  const scope = manifest.analysisCohort
  if (
    !isRecord(scope) ||
    !Array.isArray(scope.subjectIds) ||
    typeof scope.sha256 !== 'string' ||
    scope.sha256.length === 0
  ) {
    return null
  }
  return { sha256: scope.sha256, subjectCount: scope.subjectIds.length }
}

function subjectCountPhrase(count: number): string {
  return `${count} subject${count === 1 ? '' : 's'}`
}

/**
 * State how a rejected run's cohort differs from the newest run's, if it does.
 *
 * @returns A leading-space sentence, or an empty string when the cohorts match
 *   or either is unrecorded.
 */
function cohortDifference(
  run: ManifestCohort | null,
  newest: ManifestCohort | null,
): string {
  if (!run || !newest || run.sha256 === newest.sha256) return ''
  return run.subjectCount === newest.subjectCount
    ? ` They cover a different set of ${subjectCountPhrase(run.subjectCount)} than the newest run.`
    : ` They cover ${subjectCountPhrase(run.subjectCount)}, and the newest run analyzed ${subjectCountPhrase(newest.subjectCount)}.`
}

/**
 * State why the newest ENIGMA galleries cannot back new verdicts.
 *
 * Name the actual rejection, and mention the cohort only when the run's
 * analysis cohort differs from the newest run's.
 */
function earlierQcGalleryMessage(
  earlier: EarlierQcGallerySet,
  newestCohort: ManifestCohort | null,
): string {
  const cohort = cohortDifference(earlier.cohort, newestCohort)
  switch (earlier.rejection.kind) {
    case 'configChanged':
      return (
        `The newest ENIGMA QC galleries were produced under an earlier project configuration.${cohort} ` +
        'Run ENIGMA QC under the saved configuration to review galleries.'
      )
    case 'stale':
      return (
        `The newest ENIGMA QC galleries are out of date because an ENIGMA QC input changed after they were produced.${cohort} ` +
        'Rerun ENIGMA QC to review galleries.'
      )
    case 'unverifiable':
      return (
        `Supraspina could not verify the newest ENIGMA QC galleries. ${earlier.rejection.detail}${cohort} ` +
        'Reopen QC review to retry, or rerun ENIGMA QC if the problem persists.'
      )
  }
}

/**
 * Describe the expected absence of an authoritative gallery set.
 *
 * @param search - One sweep's answer without an authority.
 */
function qcAuthorityUnavailable(
  search: QcGallerySearch,
): QcAuthorityUnavailable {
  const earlier = search.earlier
  if (!earlier) {
    return {
      reason: 'noCurrentGallery',
      message: QC_AUTHORITY_UNAVAILABLE_MESSAGE,
    }
  }
  const message = earlierQcGalleryMessage(earlier, search.newestCohort)
  // Offer the run for inspection only when its galleries were seen to exist.
  return earlier.holdsGalleries
    ? {
        reason: 'earlierGallery',
        message,
        earlierRunId: earlier.inventoryRunId,
      }
    : { reason: 'noCurrentGallery', message }
}

const QC_RUN_TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
}

/**
 * State that montages and verdicts come only from the authoritative run.
 *
 * @returns A message naming the current ENIGMA run, or saying none exists and
 *   why.
 */
function nonAuthoritativeMontageMessage(search: QcGallerySearch): string {
  if (search.authority === null) {
    return `Montages and verdicts use the current ENIGMA run, and none exists. ${qcAuthorityUnavailable(search).message}`
  }
  const started = new Date(search.authority.startedAt ?? '')
  const name = Number.isFinite(started.getTime())
    ? `, the run started ${new Intl.DateTimeFormat(undefined, QC_RUN_TIMESTAMP_FORMAT).format(started)}`
    : ''
  return (
    `Montages and verdicts use the current ENIGMA run${name}. ` +
    'Select Current ENIGMA run in QC artifact run to review galleries.'
  )
}

/**
 * Bound a verifier failure for operator copy.
 *
 * @param error - The error `results.list` raised.
 * @returns One bounded sentence without local filesystem detail.
 */
function verifierFailureDetail(error: unknown): string {
  const message = publicIpcError(error).message.trim().slice(0, 300)
  if (message.length === 0) return 'The verifier did not explain the failure.'
  return /[.!?]$/.test(message) ? message : `${message}.`
}

/** One run's QC gallery verdict: authoritative, rejected, or irrelevant. */
type QcRunVerdict =
  | {
      kind: 'authority'
      galleries: Map<QcGalleryReviewEvidence['tab'], CurrentQcGallery>
    }
  | {
      kind: 'rejected'
      holdsGalleries: boolean
      rejection: QcGalleryRejection
      /** Whether the inventory call itself failed, which a retry may clear. */
      transient: boolean
    }
  | { kind: 'none' }

/** One run's cached verdict and the manifest state it was decided under. */
interface QcRunVerdictRecord {
  fingerprint: string
  /** The digest of every newer run, which an authoritative verdict needs. */
  newerDigest: string
  verdict: QcRunVerdict
  expiresAt: number
}

/**
 * Fingerprint the manifest fields that change whenever a run's outputs can.
 *
 * @returns A string that changes when the run starts, ends, finishes a node, or
 *   changes a stage's status.
 */
function manifestFingerprint(manifest: Record<string, unknown>): string {
  const graph = isRecord(manifest.graph) ? manifest.graph : {}
  const recovery = isRecord(manifest.recovery) ? manifest.recovery : {}
  const steps = Array.isArray(manifest.steps) ? manifest.steps : []
  return JSON.stringify([
    manifest.startedAt ?? null,
    manifest.endedAt ?? null,
    manifest.status ?? null,
    manifest.configSha256 ?? null,
    recovery.state ?? null,
    [graph.nodes ?? null, graph.terminal ?? null, graph.blocked ?? null],
    steps.map((step) =>
      isRecord(step)
        ? [
            step.key ?? null,
            step.status ?? null,
            step.subjects ?? null,
            step.failed ?? null,
            step.durationSec ?? null,
          ]
        : null,
    ),
  ])
}

/**
 * Decide one run's verdict, reusing it while the run and newer runs are unchanged.
 *
 * Reuse a rejection while the run's own manifest fingerprint holds. Reuse an
 * authoritative verdict only while every newer run is unchanged as well: a
 * newer run can rewrite ENIGMA QC's upstream outputs, reconstruction for
 * example, which makes an older gallery stale without touching that run's own
 * manifest. Never keep a verdict from a failed inventory call.
 *
 * @param key - The cache scope, the run's fingerprint, the newer-run digest,
 *   and the saved configuration's digest.
 */
async function qcRunVerdict(
  verifier: QcAuthorityVerifier & { sidecar: Pick<Sidecar, 'call'> },
  session: ProjectSession,
  manifest: Record<string, unknown>,
  key: {
    scope: string
    fingerprint: string
    newerDigest: string
    currentConfigSha256: string
  },
  { authorityOnly = false }: { authorityOnly?: boolean } = {},
): Promise<QcRunVerdict> {
  const cacheKey = `${key.scope}\u0000${String(manifest.runId)}`
  const hit = qcRunVerdicts.get(cacheKey)
  if (
    hit &&
    hit.expiresAt > Date.now() &&
    hit.fingerprint === key.fingerprint &&
    (hit.verdict.kind !== 'authority' || hit.newerDigest === key.newerDigest)
  ) {
    return hit.verdict
  }
  // An answer that is not the authority no longer matters once the search
  // has named the newest rejected gallery set. Rule out a run recorded under
  // another configuration from its digest alone, uncached because it is not
  // a full verdict; a full inventory of each one costs about two seconds.
  if (
    authorityOnly &&
    !(await qcRunMayBeCurrent(verifier, session, manifest, key))
  ) {
    return { kind: 'none' }
  }
  const generation = qcAuthorityGeneration
  const verdict = await inspectQcGalleryRun(
    verifier,
    session,
    manifest,
    key.currentConfigSha256,
  )
  if (
    generation === qcAuthorityGeneration &&
    !(verdict.kind === 'rejected' && verdict.transient)
  ) {
    qcRunVerdicts.delete(cacheKey)
    while (qcRunVerdicts.size >= MAX_QC_AUTHORITY_RUNS) {
      const oldest = qcRunVerdicts.keys().next().value as string | undefined
      if (oldest === undefined) break
      qcRunVerdicts.delete(oldest)
    }
    qcRunVerdicts.set(cacheKey, {
      fingerprint: key.fingerprint,
      newerDigest: key.newerDigest,
      verdict,
      expiresAt: Date.now() + QC_AUTHORITY_MEMO_MS,
    })
  }
  return verdict
}

/**
 * Report whether one durable run may hold the current gallery set.
 *
 * Ask the sidecar for the run's configuration digest without its inventory.
 * Answer true whenever the probe cannot decide, so the full inventory still
 * classifies the run.
 *
 * @returns False only for a run recorded under another configuration.
 */
async function qcRunMayBeCurrent(
  verifier: QcAuthorityVerifier & { sidecar: Pick<Sidecar, 'call'> },
  session: ProjectSession,
  manifest: Record<string, unknown>,
  key: { currentConfigSha256: string },
): Promise<boolean> {
  try {
    const page = await verifier.sidecar.call('results.list', [
      {
        project: session.ref,
        stepKey: 'enigma',
        runId: String(manifest.runId),
        limit: 50,
        currentConfigSha256: key.currentConfigSha256,
        ...(verifier.runtimeContext
          ? { runtimeContext: verifier.runtimeContext }
          : {}),
      },
    ])
    return !(
      isRecord(page) &&
      typeof page.configSha256 === 'string' &&
      page.configSha256 !== key.currentConfigSha256
    )
  } catch {
    return true
  }
}

/**
 * Inventory one durable run's ENIGMA stage and decide its gallery verdict.
 *
 * @returns The authoritative galleries, the rejection, or `none` for a run that
 *   holds no galleries.
 */
async function inspectQcGalleryRun(
  verifier: QcAuthorityVerifier & { sidecar: Pick<Sidecar, 'call'> },
  session: ProjectSession,
  manifest: Record<string, unknown>,
  currentConfigSha256: string,
): Promise<QcRunVerdict> {
  const inventoryRunId = String(manifest.runId)
  const unverifiable = (detail: string, transient: boolean): QcRunVerdict =>
    // Name a failed inventory only for a run that recorded the ENIGMA stage;
    // a manifest this build cannot read may never have produced galleries.
    manifestListsEnigma(manifest)
      ? {
          kind: 'rejected',
          holdsGalleries: false,
          rejection: { kind: 'unverifiable', detail },
          transient,
        }
      : { kind: 'none' }
  const inventory = (probe: boolean): Promise<unknown> =>
    verifier.sidecar.call('results.list', [
      {
        project: session.ref,
        stepKey: 'enigma',
        runId: inventoryRunId,
        limit: 50,
        ...(probe ? { currentConfigSha256, galleryPresence: true } : {}),
        ...(verifier.runtimeContext
          ? { runtimeContext: verifier.runtimeContext }
          : {}),
      },
    ])
  let page: unknown
  try {
    // A run under another configuration answers with its gallery presence
    // alone, which is all its verdict reads; its full inventory costs about
    // two seconds per run. A run under the saved configuration answers
    // with its full inventory.
    page = await inventory(true)
    if (
      isRecord(page) &&
      page.configSha256 !== currentConfigSha256 &&
      !Array.isArray(page.galleryPresence)
    ) {
      page = await inventory(false)
    }
  } catch (error) {
    return unverifiable(verifierFailureDetail(error), true)
  }
  if (!isRecord(page)) {
    return unverifiable('The verifier returned an invalid inventory.', false)
  }
  const current = page.configSha256 === currentConfigSha256
  const holdsGalleries = holdsProducedQcGallerySet(
    !current && Array.isArray(page.galleryPresence)
      ? { items: page.galleryPresence }
      : page,
  )
  if (!current) {
    return holdsGalleries
      ? {
          kind: 'rejected',
          holdsGalleries,
          rejection: { kind: 'configChanged' },
          transient: false,
        }
      : { kind: 'none' }
  }
  try {
    return {
      kind: 'authority',
      galleries: parseCurrentQcGallerySet(page, inventoryRunId),
    }
  } catch {
    // Classify why this run's galleries are not authoritative below.
  }
  if (page.truncated !== false || page.nextCursor !== null) {
    return {
      kind: 'rejected',
      holdsGalleries,
      rejection: {
        kind: 'unverifiable',
        detail: 'Their inventory is incomplete.',
      },
      transient: false,
    }
  }
  if (!holdsGalleries) return { kind: 'none' }
  const stale = producedQcGalleries(page).some(
    (gallery) => gallery.provenance === 'stale',
  )
  return {
    kind: 'rejected',
    holdsGalleries,
    rejection: stale
      ? { kind: 'stale' }
      : {
          kind: 'unverifiable',
          detail: 'Their receipts are missing or inconsistent.',
        },
    transient: false,
  }
}

/**
 * Search the durable runs for the current ENIGMA gallery set.
 *
 * Stop at the newest run whose complete gallery set is current under the saved
 * configuration. Also record the newest run whose galleries exist but are not
 * authoritative, with the reason, so the absence names it instead of reading
 * as though QC never ran. Reserve a thrown error for a malformed or unavailable
 * run listing, which is a real failure. Page the run listing on every call,
 * and inventory only the runs whose verdicts cannot be reused.
 */
async function searchQcGallerySets(
  verifier: QcAuthorityVerifier,
  session: ProjectSession,
): Promise<QcGallerySearch> {
  const sidecar = verifier.sidecar
  if (!sidecar) throw new Error('Make the QC gallery verifier available.')
  let earlier: EarlierQcGallerySet | null = null
  let newestCohort: ManifestCohort | null = null
  let cacheable = true
  const scope = qcAuthorityScope(session)
  const resets = qcAuthorityResets
  const currentConfigSha256 = canonicalConfigSha256(session.cfg)
  const inspected = new Set<string>()
  // Digest each run newer than the one being inspected, in listing order.
  const newer = createHash('sha256')
  let cursor: string | undefined
  while (inspected.size < MAX_QC_AUTHORITY_RUNS) {
    const manifestPage = await sidecar.call('manifest.list', [
      {
        project: session.ref,
        ...(cursor === undefined ? {} : { cursor }),
        limit: QC_AUTHORITY_PAGE_SIZE,
      },
    ])
    if (
      !isRecord(manifestPage) ||
      !Array.isArray(manifestPage.items) ||
      (manifestPage.nextCursor !== null &&
        typeof manifestPage.nextCursor !== 'string')
    ) {
      throw new Error('Provide a valid QC run authority response.')
    }
    for (const manifest of manifestPage.items) {
      if (inspected.size >= MAX_QC_AUTHORITY_RUNS) break
      if (!isRecord(manifest) || !RUN_ID.test(String(manifest.runId ?? '')))
        continue
      const inventoryRunId = String(manifest.runId)
      if (inspected.has(inventoryRunId)) continue
      inspected.add(inventoryRunId)
      const fingerprint = manifestFingerprint(manifest)
      const newerDigest = newer.copy().digest('hex')
      newer.update(`${inventoryRunId}\u0000${fingerprint}\n`)
      newestCohort ??= manifestCohort(manifest)
      // Skip a run whose manifest never recorded the ENIGMA QC stage. Reading
      // one run's artifact inventory is expensive, and a project accumulates
      // runs that produced no gallery at all, and inventorying them can take
      // many minutes on a large project.
      if (!manifestDeclaresEnigma(manifest)) continue
      const verdict = await qcRunVerdict(
        { ...verifier, sidecar },
        session,
        manifest,
        {
          scope,
          fingerprint,
          newerDigest,
          currentConfigSha256,
        },
        { authorityOnly: earlier !== null },
      )
      if (verdict.kind === 'rejected' && verdict.transient) cacheable = false
      if (verdict.kind === 'authority') {
        return {
          authority: {
            inventoryRunId,
            startedAt:
              typeof manifest.startedAt === 'string'
                ? manifest.startedAt
                : null,
            inventoryKey: sha256(
              Buffer.from(
                JSON.stringify([
                  scope,
                  inventoryRunId,
                  fingerprint,
                  newerDigest,
                  resets,
                ]),
                'utf8',
              ),
            ),
            galleries: verdict.galleries,
          },
          earlier,
          newestCohort,
          cacheable,
        }
      }
      if (verdict.kind === 'rejected' && earlier === null) {
        earlier = {
          inventoryRunId,
          holdsGalleries: verdict.holdsGalleries,
          rejection: verdict.rejection,
          cohort: manifestCohort(manifest),
        }
      }
    }
    if (
      manifestPage.nextCursor === null ||
      manifestPage.items.length === 0 ||
      inspected.size >= MAX_QC_AUTHORITY_RUNS
    ) {
      break
    }
    if (manifestPage.nextCursor === cursor) {
      throw new Error(
        'Retry QC run authority pagination from a progressing cursor.',
      )
    }
    cursor = manifestPage.nextCursor
  }
  return { authority: null, earlier, newestCohort, cacheable }
}

async function assertQcAttributionCurrent(
  verifier: QcAuthorityVerifier,
  session: ProjectSession,
  attribution: ReturnType<typeof trustedQcArtifact>,
  { memoize = false }: { memoize?: boolean } = {},
): Promise<void> {
  if (!verifier.sidecar)
    throw new Error('Make the QC gallery verifier available.')
  await assertSavedSessionCurrent(session)
  requireProject(session.ref)
  const authority = memoize
    ? requireQcAuthority(await memoizedQcGallerySearch(verifier, session))
    : await authoritativeQcGallerySet(verifier, session)
  requireProject(session.ref)
  const gallery = authority.galleries.get(attribution.tab)
  if (
    authority.inventoryRunId !== attribution.inventoryRunId ||
    !gallery ||
    gallery.label !== attribution.artifact.label ||
    gallery.displayPath !== attribution.artifact.displayPath ||
    gallery.runId !== attribution.runId ||
    gallery.receiptSha256 !== attribution.receiptSha256
  ) {
    throw new Error(
      'Reopen the QC gallery from the authoritative current ENIGMA run.',
    )
  }
}

/**
 * Refuse a montage for an ENIGMA gallery outside the authoritative run.
 *
 * Answer from the display memo that QC review's authority request filled, so
 * the refusal is immediate and names the run that montages come from instead
 * of repeating the durable-run sweep.
 *
 * @throws Error naming the current ENIGMA run, or why none exists.
 */
async function assertQcMontageRunAuthoritative(
  verifier: QcAuthorityVerifier,
  resolved: { session: ProjectSession; grant: ArtifactGrant },
): Promise<void> {
  const { grant, session } = resolved
  // Leave a grant that is not an ENIGMA gallery to the attribution check.
  if (
    grant.metadata?.stepKey !== 'enigma' ||
    typeof grant.inventoryRunId !== 'string'
  ) {
    return
  }
  if (!verifier.sidecar)
    throw new Error('Make the QC gallery verifier available.')
  await assertSavedSessionCurrent(session)
  requireProject(session.ref)
  const search = await memoizedQcGallerySearch(verifier, session)
  requireProject(session.ref)
  if (search.authority?.inventoryRunId !== grant.inventoryRunId) {
    throw new Error(nonAuthoritativeMontageMessage(search))
  }
}

function qcGalleryViewKey(
  session: ProjectSession,
  ownerId: number,
  galleryArtifactId: string,
  subjectId: string,
): string {
  return [
    session.ref.projectId,
    String(ownerId),
    galleryArtifactId,
    subjectId,
  ].join('\0')
}

function forgetQcGalleryView(key: string): void {
  const view = qcGalleryViews.get(key)
  if (!view) return
  qcGalleryViews.delete(key)
  const owned = new Set(
    [...view.montageArtifactIds, ...view.fullArtifactIds].map((artifactId) =>
      artifactKey(view.projectId, artifactId),
    ),
  )
  for (const [imageKey, image] of qcGalleryImages) {
    if (
      image.projectId === view.projectId &&
      image.projectEpoch === view.projectEpoch &&
      owned.has(imageKey)
    ) {
      qcGalleryImages.delete(imageKey)
    }
  }
}

/**
 * Parse the detector's verified montage description.
 *
 * Derive every display value from this description. Check its shape
 * exhaustively, and reject the whole montage after any invalid field.
 */
function parseQcGalleryPanels(value: unknown): QcGalleryPanel[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.panels) ||
    value.panels.length === 0 ||
    value.panels.length > MAX_QC_GALLERY_PANELS
  ) {
    throw new Error(
      'Regenerate the QC montage with a complete detector description.',
    )
  }
  const seenKeys = new Set<string>()
  const seenArtifacts = new Set<string>()
  const panels = value.panels.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.key !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.key) ||
      seenKeys.has(entry.key) ||
      typeof entry.group !== 'string' ||
      entry.group.length === 0 ||
      entry.group.length > 64 ||
      typeof entry.detail !== 'string' ||
      entry.detail.length === 0 ||
      entry.detail.length > 64 ||
      typeof entry.label !== 'string' ||
      entry.label.length === 0 ||
      entry.label.length > 128
    ) {
      throw new Error(
        'Regenerate the QC montage with valid panel descriptions.',
      )
    }
    seenKeys.add(entry.key)
    const image = (role: 'montage' | 'full'): QcGalleryImage => {
      const raw = entry[role]
      if (
        !isRecord(raw) ||
        typeof raw.artifactId !== 'string' ||
        raw.artifactId.length === 0 ||
        raw.artifactId.length > 256 ||
        typeof raw.displayPath !== 'string' ||
        raw.displayPath.length === 0 ||
        raw.displayPath.length > 16_384 ||
        typeof raw.bytes !== 'number' ||
        !Number.isSafeInteger(raw.bytes) ||
        raw.bytes <= 0 ||
        raw.bytes > MAX_IMAGE_BYTES ||
        typeof raw.sha256 !== 'string' ||
        !RECEIPT_DIGEST.test(raw.sha256) ||
        seenArtifacts.has(raw.artifactId)
      ) {
        throw new Error(
          'Regenerate the QC montage with valid image descriptions.',
        )
      }
      seenArtifacts.add(raw.artifactId)
      return {
        artifactId: raw.artifactId,
        displayPath: raw.displayPath,
        bytes: raw.bytes,
        sha256: raw.sha256,
      }
    }
    return {
      key: entry.key,
      group: entry.group,
      detail: entry.detail,
      label: entry.label,
      montage: image('montage'),
      full: image('full'),
    }
  })
  return panels
}

/**
 * Resolve, verify, and issue the native montage for one subject and gallery.
 *
 * Apply the external-open checks to the gallery artifact. Accept montage
 * descriptions only from the detector.
 */
async function issueQcGalleryView(
  request: unknown,
  verifier: QcAuthorityVerifier,
  ownerId: number,
): Promise<QcGalleryView> {
  if (!isRecord(request)) throw new Error('Provide a valid QC montage request.')
  const resolved = await resolveArtifactGrant(
    request,
    verifier.sidecar,
    ownerId,
  )
  const subjectId = String(request.subjectId ?? '')
  if (!isSafeSegment(subjectId) || subjectId.length > 128) {
    throw new Error('Provide a valid QC montage subject.')
  }
  await assertQcMontageRunAuthoritative(verifier, resolved)
  const attribution = trustedQcArtifact(resolved.grant, resolved.session)
  // Treat the montage as display-only data. Reuse a recent authority answer,
  // and resolve authority directly during attestation.
  await assertQcAttributionCurrent(verifier, resolved.session, attribution, {
    memoize: true,
  })
  const sidecar = verifier.sidecar
  if (!sidecar) throw new Error('Make the QC gallery verifier available.')
  const described = await sidecar.call('results.qcGalleryImages', [
    {
      project: resolved.session.ref,
      runId: attribution.inventoryRunId,
      tab: attribution.tab,
      subjectId,
    },
  ])
  requireProject(resolved.session.ref)
  if (
    !isRecord(described) ||
    described.tab !== attribution.tab ||
    described.subjectId !== subjectId ||
    described.runId !== attribution.inventoryRunId ||
    described.configSha256 !== attribution.inventoryConfigSha256
  ) {
    throw new Error(
      'Request the QC montage again with matching detector evidence.',
    )
  }
  const panels = parseQcGalleryPanels(described)
  const imagesChanged = parseImagesChangedSinceVerdict(
    described.imagesChangedSinceVerdict,
  )
  const key = qcGalleryViewKey(
    resolved.session,
    ownerId,
    String(request.artifactId ?? ''),
    subjectId,
  )
  forgetQcGalleryView(key)
  while (qcGalleryViews.size >= MAX_QC_GALLERY_VIEWS) {
    const oldest = qcGalleryViews.keys().next().value as string | undefined
    if (oldest === undefined) break
    forgetQcGalleryView(oldest)
  }
  for (const panel of panels) {
    for (const image of [panel.montage, panel.full]) {
      qcGalleryImages.set(
        artifactKey(resolved.session.ref.projectId, image.artifactId),
        {
          ownerId,
          projectId: resolved.session.ref.projectId,
          projectEpoch: resolved.session.ref.epoch,
          bytes: image.bytes,
          sha256: image.sha256,
          displayed: false,
        },
      )
    }
  }
  qcGalleryViews.set(key, {
    ownerId,
    projectId: resolved.session.ref.projectId,
    projectEpoch: resolved.session.ref.epoch,
    configRevision: resolved.session.configRevision,
    configSha256: resolved.session.configSha256,
    subjectId,
    tab: attribution.tab,
    galleryArtifactId: String(request.artifactId ?? ''),
    inventoryRunId: attribution.inventoryRunId,
    runId: attribution.runId,
    receiptSha256: attribution.receiptSha256,
    montageArtifactIds: panels.map((panel) => panel.montage.artifactId),
    fullArtifactIds: panels.map((panel) => panel.full.artifactId),
    expiresAt: Date.now() + QC_GALLERY_VIEW_TTL_MS,
  })
  return {
    tab: attribution.tab,
    subjectId,
    runId: attribution.runId,
    receiptSha256: attribution.receiptSha256,
    inventoryRunId: attribution.inventoryRunId,
    panels,
    ...(imagesChanged ? { imagesChangedSinceVerdict: imagesChanged } : {}),
  }
}

/**
 * Mint a review grant for a montage this application actually displayed.
 *
 * Treat in-app review as evidence only after serving every panel from the
 * detector-verified bytes. Refuse the grant until every panel has been served.
 */
async function attestQcGalleryView(
  request: unknown,
  verifier: QcAuthorityVerifier,
  ownerId: number,
): Promise<{ reviewGrant: QcReviewOpenGrant }> {
  if (!isRecord(request)) throw new Error('Provide a valid QC montage request.')
  const resolved = await resolveArtifactGrant(
    request,
    verifier.sidecar,
    ownerId,
  )
  const subjectId = String(request.subjectId ?? '')
  const galleryArtifactId = String(request.artifactId ?? '')
  const key = qcGalleryViewKey(
    resolved.session,
    ownerId,
    galleryArtifactId,
    subjectId,
  )
  const view = qcGalleryViews.get(key)
  if (
    !view ||
    view.expiresAt < Date.now() ||
    view.projectEpoch !== resolved.session.ref.epoch ||
    view.configRevision !== resolved.session.configRevision ||
    view.configSha256 !== resolved.session.configSha256
  ) {
    forgetQcGalleryView(key)
    throw new Error(
      'View the QC montage again because it is no longer current.',
    )
  }
  const displayed = view.montageArtifactIds.every(
    (artifactId) =>
      qcGalleryImages.get(artifactKey(view.projectId, artifactId))
        ?.displayed === true,
  )
  if (!displayed) {
    throw new Error(
      'Display the complete QC montage before recording review evidence.',
    )
  }
  const attribution = trustedQcArtifact(resolved.grant, resolved.session)
  if (
    attribution.tab !== view.tab ||
    attribution.runId !== view.runId ||
    attribution.receiptSha256 !== view.receiptSha256 ||
    attribution.inventoryRunId !== view.inventoryRunId
  ) {
    forgetQcGalleryView(key)
    throw new Error(
      'View the QC montage again because it is no longer current.',
    )
  }
  await assertQcAttributionCurrent(verifier, resolved.session, attribution)
  const lease = await openArtifactLease(resolved.path, resolved.info, 'file')
  try {
    const path = await revalidateArtifactLease(resolved, lease)
    if (lease.info.size <= 0 || lease.info.size > MAX_QC_GALLERY_BYTES) {
      throw new Error('Select a readable detector-generated QC gallery.')
    }
    const gallery = await readBounded(lease, MAX_QC_GALLERY_BYTES)
    if (!gallery.includes(Buffer.from(subjectId, 'utf8'))) {
      throw new Error('Open the QC gallery that references this subject.')
    }
    return {
      reviewGrant: issueQcReviewGrant(
        resolved.session,
        ownerId,
        subjectId,
        galleryArtifactId,
        path,
        lease.info,
        gallery,
        attribution,
        new Date().toISOString(),
      ),
    }
  } finally {
    await lease.handle.close()
  }
}

async function assertQcGrantFileCurrent(
  session: ProjectSession,
  grant: QcReviewGrantRecord,
): Promise<void> {
  const latest = await validateArtifactPath(session, grant.path)
  if (!sameFileIdentity(grant.fileInfo, latest.info)) {
    throw new Error(
      'Open the QC gallery again because it changed after opening.',
    )
  }
  const lease = await openArtifactLease(grant.path, grant.fileInfo, 'file')
  try {
    const bytes = await readBounded(lease, MAX_QC_GALLERY_BYTES)
    if (
      lease.info.size !== grant.fileInfo.size ||
      sha256(bytes) !== grant.fileSha256 ||
      !galleryNamesSubject(bytes, grant.subjectId)
    ) {
      throw new Error(
        'Open the QC gallery again because it changed after opening.',
      )
    }
  } finally {
    await lease.handle.close()
  }
}

async function validateQcReviewGrants(
  grantIds: string[],
  session: ProjectSession,
  subjectId: string,
  ownerId: number,
  verifier: QcAuthorityVerifier,
): Promise<{ evidence: QcReviewEvidence; grantIds: string[] }> {
  if (new Set(grantIds).size !== QC_GALLERY_TABS.length) {
    throw new Error('Provide three distinct QC review grants.')
  }
  const now = Date.now()
  const grants = grantIds.map((grantId) => qcReviewGrants.get(grantId))
  if (
    grants.some(
      (grant) =>
        !grant ||
        grant.ownerId !== ownerId ||
        grant.projectId !== session.ref.projectId ||
        grant.projectEpoch !== session.ref.epoch ||
        grant.configRevision !== session.configRevision ||
        grant.configSha256 !== session.configSha256 ||
        grant.inventoryConfigSha256 !== canonicalConfigSha256(session.cfg) ||
        grant.subjectId !== subjectId ||
        grant.expiresAt < now,
    )
  ) {
    throw new Error(
      'Open the current QC galleries again to issue fresh review grants.',
    )
  }
  const complete = grants as QcReviewGrantRecord[]
  if (
    new Set(complete.map((grant) => grant.tab)).size !==
      QC_GALLERY_TABS.length ||
    new Set(complete.map((grant) => grant.inventoryRunId)).size !== 1 ||
    new Set(complete.map((grant) => grant.runId)).size !== 1 ||
    new Set(complete.map((grant) => grant.receiptSha256)).size !== 1
  ) {
    throw new Error(
      'Use QC review grants from one subject, run, receipt, and gallery set.',
    )
  }
  if (!verifier.sidecar)
    throw new Error('Make the QC gallery verifier available.')
  await assertSavedSessionCurrent(session)
  await Promise.all(
    complete.map((grant) => assertQcGrantFileCurrent(session, grant)),
  )
  const inventoryRunId = complete[0]!.inventoryRunId
  const authority = await authoritativeQcGallerySet(verifier, session)
  const current = authority.galleries
  requireProject(session.ref)
  if (authority.inventoryRunId !== inventoryRunId) {
    throw new Error('Open galleries from the authoritative current QC run.')
  }
  for (const grant of complete) {
    const gallery = current.get(grant.tab)
    if (
      !gallery ||
      gallery.label !== grant.label ||
      gallery.displayPath !== grant.displayPath ||
      gallery.runId !== grant.runId ||
      gallery.receiptSha256 !== grant.receiptSha256
    ) {
      throw new Error('Open every gallery in the current QC set again.')
    }
  }
  complete.sort(
    (left, right) =>
      QC_GALLERY_TABS.indexOf(left.tab) - QC_GALLERY_TABS.indexOf(right.tab),
  )
  return {
    grantIds: [...grantIds],
    evidence: {
      evidenceVersion: 1,
      reviewer: reviewerIdentity(),
      reviewedAt: new Date().toISOString(),
      galleries: complete.map((grant) => ({
        tab: grant.tab,
        label: grant.label,
        displayPath: grant.displayPath,
        runId: grant.runId,
        receiptSha256: grant.receiptSha256,
        openedAt: grant.openedAt,
      })),
    },
  }
}

function detectPlatform(): PlatformMode {
  // Support only native Linux and Ubuntu under WSL2. Reject every other host
  // explicitly rather than degrading it to an approximate platform contract.
  if (process.platform !== 'linux') {
    throw new Error(
      `Run Supraspina on a supported Linux host; ${process.platform} is unsupported.`,
    )
  }
  try {
    if (
      existsSync('/proc/version') &&
      /microsoft/i.test(readFileSync('/proc/version', 'utf8'))
    ) {
      return 'wsl'
    }
  } catch {
    // Fall through to native Linux.
  }
  return 'linux'
}

const execFileAsync = promisify(execFile)

async function translatePath(
  value: string,
  flag: '-w' | '-u',
): Promise<string> {
  if (detectPlatform() !== 'wsl') return value
  if (/[\n\r\0]/.test(value)) {
    throw new Error(
      'Remove newline and NUL bytes before translating a platform path.',
    )
  }
  try {
    const { stdout } = await execFileAsync('wslpath', [flag, value])
    return stdout.replace(/\n+$/, '') || value
  } catch {
    return value
  }
}

function unavailableSidecarState(): SidecarHostState {
  return {
    state: 'unavailable',
    generation: 0,
    productVersion: null,
    protocolVersion: null,
    persistenceVersions: null,
    capabilities: [],
    runtimeId: null,
    projectAttached: false,
    retryable: true,
    detail: 'Retry after the scientific runtime becomes available, or quit.',
  }
}

/**
 * Record which sidecar result failed its renderer contract.
 *
 * The renderer receives only the redacted contract sentence, so the main log is
 * the one place that identifies the call. Name the method and, for a list
 * result, the row that failed. Never write the record itself: the sentence a
 * result parser throws names the field, not its value.
 */
function logSidecarContractFailure(method: string, error: unknown): void {
  const rowIndex = contractRowIndex(error)
  const subject = rowIndex === null ? 'result' : `result row ${rowIndex}`
  const reason = error instanceof Error ? error.message : 'Unknown failure.'
  log.error(`Inspect the ${method} sidecar ${subject}: ${reason}`)
}

function publicIpcError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error('Retry the requested operation.')
  }
  if (
    error instanceof PlanStaleError ||
    error instanceof BoundaryExpiredError
  ) {
    return new Error(serializePublicRpcError(error))
  }
  const local = error as NodeJS.ErrnoException & {
    path?: unknown
    dest?: unknown
    syscall?: unknown
  }
  if (
    typeof local.path === 'string' ||
    typeof local.dest === 'string' ||
    typeof local.syscall === 'string'
  ) {
    return new Error(
      'Check permissions and free disk space, then retry the local file operation.',
    )
  }
  return error
}

async function openLocalPath(path: string, label: string): Promise<void> {
  let detail: string
  try {
    detail = await shell.openPath(path)
  } catch {
    throw new Error(`Retry opening ${label} through the operating system.`)
  }
  if (detail) {
    throw new Error(`Retry opening ${label} through the operating system.`)
  }
}

function revealLocalPath(path: string, label: string): void {
  try {
    shell.showItemInFolder(path)
  } catch {
    throw new Error(`Retry revealing ${label} through the operating system.`)
  }
}

function hostState(sidecar?: Pick<Sidecar, 'getState'>): HostState {
  const platform = detectPlatform()
  return {
    mode: 'electron',
    platform,
    captionMode: 'custom',
    sidecar: sidecar?.getState() ?? unavailableSidecarState(),
  }
}

function requireLifecycle(services: HandlerServices): LifecycleHooks {
  if (!services.lifecycle)
    throw new Error('Make the lifecycle coordinator available.')
  return services.lifecycle
}

function requirePreferences(
  services: HandlerServices,
): MachinePreferenceController {
  if (!services.preferences)
    throw new Error('Make the machine preferences available.')
  return services.preferences
}

function requireWindowPlacement(
  services: HandlerServices,
): WindowPlacementController {
  if (!services.windowPlacement)
    throw new Error('Make the window placement controller available.')
  return services.windowPlacement
}

/** The window whose renderer sent the invocation, when it still exists. */
function invokingWindow(
  invocation: InvocationContext | undefined,
): BrowserWindow | null {
  if (!invocation) return null
  return (
    BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === invocation.senderId,
    ) ?? null
  )
}

/** Show an open dialog, attached to the invoking window when it exists. */
function showOpenDialogFor(
  invocation: InvocationContext | undefined,
  options: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  const window = invokingWindow(invocation)
  return window
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options)
}

/** Show a message box, attached to the invoking window when it exists. */
function showMessageBoxFor(
  invocation: InvocationContext | undefined,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  const window = invokingWindow(invocation)
  return window
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options)
}

/**
 * The machine-level tools main attaches to the labeling and atlas-import
 * requests: the subregions interpreter (a machine preference) and the
 * machine-level atlas cache folder.
 */
interface MachineTools {
  subregionsPython: string | null
  atlasCacheRoot: string | null
}

function machineTools(
  services: Pick<HandlerServices, 'preferences' | 'userDataPath'>,
): MachineTools {
  return {
    subregionsPython: services.preferences?.getSubregionsPython() ?? null,
    atlasCacheRoot: services.userDataPath
      ? atlasCacheRoot(services.userDataPath)
      : null,
  }
}

/** The most rows an export reads from one v2 result (a 32 MiB record holds fewer). */
const MAX_EXPORT_TERM_ROWS = 200_000

/**
 * Read a v2 result's terms and every term's rows for an export, page by
 * page, checking each page belongs to the term and offset asked for.
 *
 * @returns The terms, rows, and spec, or null for a v1 result.
 * @throws Error when a page does not match the request.
 */
async function exportTermData(
  call: (method: string, fields: Record<string, unknown>) => Promise<unknown>,
  resultId: string,
): Promise<AnalysisExportTerms | null> {
  const header = parseGroupAnalysisResult(
    await call('groupAnalysis.result', { resultId }),
  )
  if (header.resultId !== resultId) {
    throw new Error('The workflow service returned another result to export.')
  }
  if (header.schemaVersion !== 2) return null
  const rows: GroupAnalysisRowV2[] = []
  for (const term of header.terms) {
    let offset: number | null = 0
    while (offset !== null) {
      const page = parseGroupAnalysisTermRows(
        await call('groupAnalysis.termRows', {
          resultId,
          termId: term.termId,
          offset,
        }),
      )
      if (
        page.resultId !== resultId ||
        page.termId !== term.termId ||
        page.offset !== offset ||
        (page.nextOffset !== null && page.nextOffset <= offset) ||
        page.rows.some((row) => row.termId !== term.termId)
      ) {
        throw new Error('The workflow service returned the wrong term rows.')
      }
      rows.push(...page.rows)
      if (rows.length > MAX_EXPORT_TERM_ROWS) {
        throw new Error('The result has too many rows to export.')
      }
      offset = page.nextOffset
    }
  }
  return { terms: header.terms, rows, spec: header.spec }
}

/**
 * Call a main-internal sidecar method for the session's project, with the
 * saved configuration attached as for every project-reference call.
 */
async function callSidecarForProject(
  services: HandlerServices,
  session: ProjectSession,
  method: string,
  fields: Record<string, unknown>,
): Promise<unknown> {
  const current = requireProject(session.ref)
  if (!services.sidecar) {
    throw new Error('Start the workflow service before this step.')
  }
  return services.sidecar.call(method, [
    {
      project: current.ref,
      ...fields,
      cfg: current.cfg,
      configRevision: current.configRevision,
      configSha256: current.configSha256,
    },
  ])
}

/** Build the exact table of native IPC methods. */
export function nativeHandlers(
  services: HandlerServices = {},
): Record<string, NativeHandler> {
  const qcVerifier: QcAuthorityVerifier = {
    sidecar: services.sidecar,
    runtimeContext: qcRuntimeContext(services.userDataPath),
  }
  const atlasSources =
    services.atlasSources ??
    (services.userDataPath
      ? new AtlasSourceManager({
          userDataPath: services.userDataPath,
          openExternal: (url) => shell.openExternal(url),
        })
      : null)
  const requireAtlasSources = (): AtlasSourceManager => {
    if (!atlasSources) {
      throw new Error('Make the machine data folder available.')
    }
    return atlasSources
  }
  const callProjectSidecar = (
    session: ProjectSession,
    method: string,
    fields: Record<string, unknown>,
  ): Promise<unknown> =>
    callSidecarForProject(services, session, method, fields)
  return {
    'project.create': async ([request]) =>
      serializeWrite(projectOperationChains, 'global-project-boundary', () =>
        createProject(request, services.sidecar),
      ),
    'project.open': async ([request]) =>
      serializeWrite(projectOperationChains, 'global-project-boundary', () =>
        openProject(request, services.sidecar),
      ),
    'project.close': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid project.close request.')
      await invalidateActiveProject(services.sidecar, request.project)
    },
    'project.save': async ([request]) =>
      serializeWrite(projectOperationChains, 'global-project-boundary', () =>
        saveProject(request),
      ),
    'project.validate': async ([candidate]) => {
      const validation = validateProjectConfig(candidate)
      return {
        errors: validation.errors,
        warnings: validation.warnings,
      }
    },
    'host.getState': async () => hostState(services.sidecar),
    'host.retrySidecar': async () => {
      if (!services.sidecar)
        throw new Error('Make the scientific runtime available.')
      await services.sidecar.retry()
    },
    'preferences.get': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for preferences.get.')
      return requirePreferences(services).getState()
    },
    'preferences.patch': async (args) => {
      if (args.length !== 1)
        throw new Error('Provide valid arguments for preferences.patch.')
      return requirePreferences(services).patch(args[0])
    },
    'preferences.reset': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for preferences.reset.')
      const state = requirePreferences(services).reset()
      services.windowPlacement?.resetPreference()
      return state
    },
    'windowPlacement.getState': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for window placement.')
      return requireWindowPlacement(services).getState()
    },
    'windowPlacement.setPreference': async (args) => {
      if (args.length !== 1)
        throw new Error('Provide valid arguments for window placement.')
      const preference = args[0]
      if (!isWindowPlacementPreference(preference)) {
        throw new Error('Provide a valid window placement preference.')
      }
      return requireWindowPlacement(services).setPreference(preference)
    },
    'windowPlacement.moveNow': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for window placement.')
      return requireWindowPlacement(services).moveNow()
    },
    'windowPlacement.identifyDisplays': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for window placement.')
      requireWindowPlacement(services).identifyDisplays()
    },
    'platform.detect': async () => detectPlatform(),
    'platform.cpuCount': async () => cpus().length || null,
    'platform.toNative': async ([path]) => translatePath(String(path), '-w'),
    'platform.fromNative': async ([path]) => translatePath(String(path), '-u'),
    'fs.chooseDir': async ([opts]) => {
      const options = isRecord(opts) ? opts : {}
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        ...(typeof options.defaultPath === 'string'
          ? { defaultPath: options.defaultPath }
          : {}),
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    'fs.chooseFile': async ([opts]) => {
      const options = isRecord(opts) ? opts : {}
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        ...(Array.isArray(options.filters)
          ? { filters: options.filters as never }
          : {}),
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    'fs.chooseSavePath': async ([opts], invocation) => {
      const options = isRecord(opts) ? opts : {}
      const session = requireProject(options.project)
      const purpose = options.purpose
      if (
        purpose !== 'subjects-csv' &&
        purpose !== 'debug-bundle' &&
        purpose !== 'registry-import-example'
      ) {
        throw new Error('Provide a valid save destination purpose.')
      }
      const result = await dialog.showSaveDialog({
        ...(typeof options.defaultPath === 'string'
          ? { defaultPath: options.defaultPath }
          : {}),
        ...(Array.isArray(options.filters)
          ? { filters: options.filters as never }
          : {}),
      })
      const path = result.canceled ? undefined : result.filePath
      return path
        ? registerDestination(path, invocation?.senderId ?? 0, purpose, session)
        : null
    },
    'external.openWeb': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid web destination request.')
      const url = String(request.url ?? '')
      const purpose = String(request.purpose ?? '') as WebPurpose
      if (!isAllowedWebDestination(url, purpose)) {
        throw new Error(
          'Open only an approved web destination for this purpose.',
        )
      }
      try {
        await shell.openExternal(url)
      } catch {
        throw new Error(
          'Retry the approved web destination through the operating system.',
        )
      }
    },
    'external.openThirdPartyNotices': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for third-party notices.')
      const path = services.thirdPartyNoticesPath
      if (!path || !isAbsolute(path)) {
        throw new Error('Make the third-party notices available.')
      }
      try {
        const info = await lstat(path)
        if (!info.isFile())
          throw new Error('Provide third-party notices as a regular file.')
        const error = await shell.openPath(path)
        if (error)
          throw new Error(
            'Open the third-party notices through an available system handler.',
          )
      } catch {
        throw new Error(
          'Make the third-party notices readable by an operating-system handler.',
        )
      }
    },
    'execution.authorize': async ([request], invocation) =>
      authorizeExecution(request, invocation?.senderId ?? 0),
    'qc.authoritativeRun': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid QC authority request.')
      const session = requireProject(request.project)
      await assertSavedSessionCurrent(session)
      // Fill the display memo, so a montage requested next for a run that is
      // not authoritative is refused without another sweep.
      const search = await memoizedQcGallerySearch(qcVerifier, session)
      requireProject(session.ref)
      if (search.authority === null) {
        // Report the governed operator precondition as an expected answer so a
        // project that has not produced a current gallery set is not treated as
        // an unexpected main-process failure. Name the newest galleries that
        // exist and why they cannot back verdicts; they stay non-authoritative.
        return {
          runId: null,
          unavailable: qcAuthorityUnavailable(search),
          inventoryKey: null,
        }
      }
      return {
        runId: search.authority.inventoryRunId,
        unavailable: null,
        inventoryKey: search.authority.inventoryKey,
      }
    },
    'qc.galleryImages': async ([request], invocation) =>
      issueQcGalleryView(request, qcVerifier, invocation?.senderId ?? 0),
    'qc.attestGalleryView': async ([request], invocation) =>
      attestQcGalleryView(request, qcVerifier, invocation?.senderId ?? 0),
    'artifact.open': async ([request], invocation) => {
      const resolved = await resolveArtifactGrant(
        request,
        services.sidecar,
        invocation?.senderId,
      )
      if (!resolved.info.isFile()) {
        throw new Error(
          'Use Open for verified local files; use Reveal or List for directories.',
        )
      }
      const lease = await openArtifactLease(
        resolved.path,
        resolved.info,
        'file',
      )
      try {
        const path = await revalidateArtifactLease(resolved, lease)
        const focusText = isRecord(request) ? request.focusText : undefined
        let reviewGrant: QcReviewOpenGrant | null = null
        if (focusText !== undefined) {
          if (
            typeof focusText !== 'string' ||
            !QC_FOCUS_TEXT.test(focusText) ||
            !/\.html?$/i.test(path) ||
            lease.info.size > MAX_QC_GALLERY_BYTES
          ) {
            throw new Error('Provide a valid QC gallery subject focus.')
          }
          const gallery = await readBounded(lease, MAX_QC_GALLERY_BYTES)
          if (!galleryNamesSubject(gallery, focusText)) {
            throw new Error(
              'Select a subject present in this verified gallery.',
            )
          }
          const attribution = trustedQcArtifact(
            resolved.grant,
            resolved.session,
          )
          await assertQcAttributionCurrent(
            qcVerifier,
            resolved.session,
            attribution,
          )
          const url = `${pathToFileURL(path).href}#:~:text=${encodeURIComponent(focusText)}`
          try {
            await shell.openExternal(url)
          } catch {
            throw new Error(
              'Use Reveal if the operating system cannot open the focused QC gallery.',
            )
          }
          const openedAt = new Date().toISOString()
          reviewGrant = issueQcReviewGrant(
            resolved.session,
            invocation?.senderId ?? 0,
            focusText,
            String(isRecord(request) ? request.artifactId : ''),
            path,
            lease.info,
            gallery,
            attribution,
            openedAt,
          )
        } else {
          await openLocalPath(path, 'the artifact')
        }
        return {
          openedAt: reviewGrant?.openedAt ?? new Date().toISOString(),
          reviewGrant,
        }
      } finally {
        await lease.handle.close()
      }
    },
    'artifact.reveal': async ([request], invocation) => {
      const resolved = await resolveArtifactGrant(
        request,
        services.sidecar,
        invocation?.senderId,
      )
      const kind = resolved.info.isDirectory() ? 'directory' : 'file'
      const lease = await openArtifactLease(resolved.path, resolved.info, kind)
      try {
        const path = await revalidateArtifactLease(resolved, lease)
        revealLocalPath(path, 'the artifact')
      } finally {
        await lease.handle.close()
      }
    },
    'artifact.list': async ([request], invocation) =>
      listArtifact(request, services.sidecar, invocation?.senderId),
    'artifact.readText': async ([request], invocation) =>
      readArtifactText(
        request,
        services.sidecar,
        invocation?.senderId,
        services.artifactUseBarrier,
      ),
    'artifact.previewImage': async ([request], invocation) =>
      previewArtifactImage(request, services.sidecar, invocation?.senderId),
    'subjects.openFolder': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid subject folder request.')
      const session = requireProject(request.project)
      const subjectId = String(request.subjectId ?? '')
      if (!isSafeSegment(subjectId) || subjectId.length > 128) {
        throw new Error('Provide a valid subject ID.')
      }
      const derivatives = concretePath(session.cfg, '${paths.derivativesDir}')
      if (!derivatives) throw new Error('Resolve the derivatives directory.')
      const candidate = join(derivatives, 'freesurfer', subjectId)
      const validated = await validateArtifactPath(session, candidate)
      revealLocalPath(validated.path, 'the subject folder')
    },
    'subjects.openLog': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid subject log request.')
      const session = requireProject(request.project)
      const subjectId = String(request.subjectId ?? '')
      if (!isSafeSegment(subjectId) || subjectId.length > 128) {
        throw new Error('Provide a valid subject ID.')
      }
      let step: string | null = null
      if (request.stepKey !== undefined) {
        if (
          typeof request.stepKey !== 'string' ||
          !STEP_KEYS.includes(request.stepKey as StepKey)
        ) {
          throw new Error('Provide a valid subject log step.')
        }
        step = request.stepKey
      }
      const runsDir = join(session.ref.root, SUPRASPINA_DIR, 'runs')
      const logPath = await newestSubjectLog(
        session,
        services.sidecar,
        subjectId,
        step,
      )
      if (!logPath)
        throw new Error('Generate a persisted log for this subject.')
      const validated = await validateArtifactPath(session, logPath, [runsDir])
      await openLocalPath(validated.path, 'the subject log')
    },
    'subjects.exportCsv': async ([request], invocation) => {
      if (!isRecord(request))
        throw new Error('Provide a valid CSV export request.')
      const session = requireProject(request.project)
      const rows = parseSubjectExportRows(request.rows)
      const destination = await consumeDestination(
        request.destinationId,
        invocation?.senderId ?? 0,
        'subjects-csv',
        session,
      )
      requireProject(session.ref)
      await writeBytesAtomic(destination, subjectsCsv(rows))
    },
    'subjects.markQc': async ([request], invocation) =>
      markQc(request, qcVerifier, invocation?.senderId ?? 0),
    'registry.chooseImportCsv': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid registry import request.')
      const session = requireProject(request.project)
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      const path = result.canceled ? undefined : result.filePaths[0]
      if (!path) return null
      requireProject(session.ref)
      const { bytes } = await readRegularFileBounded(
        path,
        MAX_REGISTRY_IMPORT_BYTES,
        'the registry import file',
      )
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error('Provide a UTF-8 encoded CSV file.')
      }
      return { name: basename(path), displayPath: path, text }
    },
    'registry.saveExampleCsv': async ([request], invocation) => {
      if (!isRecord(request))
        throw new Error('Provide a valid example CSV request.')
      const session = requireProject(request.project)
      const destination = await consumeDestination(
        request.destinationId,
        invocation?.senderId ?? 0,
        'registry-import-example',
        session,
      )
      requireProject(session.ref)
      await writeBytesAtomic(
        destination,
        Buffer.from(REGISTRY_IMPORT_EXAMPLE_CSV, 'utf8'),
      )
    },
    'groupAnalysis.chooseSetCsv': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid set import request.')
      assertExactObjectKeys(request, ['project'], 'the set import request')
      const session = requireProject(request.project)
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      const path = result.canceled ? undefined : result.filePaths[0]
      if (!path) return null
      requireProject(session.ref)
      const { bytes } = await readRegularFileBounded(
        path,
        MAX_ANALYSIS_SET_IMPORT_BYTES,
        'the measure set file',
      )
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error('Provide a UTF-8 encoded CSV file.')
      }
      return { name: basename(path), displayPath: path, text }
    },
    'groupAnalysis.chooseExportFolder': async ([request], invocation) => {
      if (!isRecord(request))
        throw new Error('Provide a valid export folder request.')
      assertExactObjectKeys(
        request,
        ['project', 'defaultName'],
        'the export folder request',
      )
      const session = requireProject(request.project)
      if (
        typeof request.defaultName !== 'string' ||
        !ANALYSIS_EXPORT_NAME.test(request.defaultName)
      ) {
        throw new Error('Name the export folder with [a-z0-9._-] characters.')
      }
      return chooseAnalysisExportFolder({
        projectRoot: session.ref.root,
        defaultName: request.defaultName,
        window: invokingWindow(invocation),
        forbiddenRoots: pipelineWriteRoots(session),
        register: (path) => {
          requireProject(session.ref)
          return registerDestination(
            path,
            invocation?.senderId ?? 0,
            'analysis-export',
            session,
          )
        },
      })
    },
    'groupAnalysis.writeExport': async ([request], invocation) => {
      if (!isRecord(request)) throw new Error('Provide a valid export request.')
      const { project, ...fields } = request
      const session = requireProject(project)
      const parsed = parseAnalysisExportRequest(fields)
      const parent = await consumeDestination(
        parsed.destinationId,
        invocation?.senderId ?? 0,
        'analysis-export',
        session,
      )
      return writeAnalysisExport({
        parent,
        forbiddenRoots: pipelineWriteRoots(session),
        request: parsed,
        exportData: async (resultId, subjectCsv) => {
          const current = requireProject(session.ref)
          if (!services.sidecar) {
            throw new Error('Start the workflow service before exporting.')
          }
          return parseGroupAnalysisExportData(
            await services.sidecar.call('groupAnalysis.exportData', [
              {
                project: current.ref,
                resultId,
                subjectCsv,
                cfg: current.cfg,
                configRevision: current.configRevision,
                configSha256: current.configSha256,
              },
            ]),
          )
        },
        termData: (resultId) =>
          exportTermData(
            (method, fields) => callProjectSidecar(session, method, fields),
            resultId,
          ),
        atlasFacts: async () => ({
          catalog: await callProjectSidecar(session, 'groupAnalysis.atlases', {
            machine: machineTools(services),
            reconOutdatedSubjectIds: [],
          })
            .then(parseAtlasCatalog)
            .catch(() => null),
          sources: (await atlasSources?.list().catch(() => null)) ?? null,
        }),
        pinResult: async (resultId) => {
          const current = requireProject(session.ref)
          if (!services.sidecar) return
          await services.sidecar.call('groupAnalysis.pinResult', [
            {
              project: current.ref,
              resultId,
              cfg: current.cfg,
              configRevision: current.configRevision,
              configSha256: current.configSha256,
            },
          ])
        },
      })
    },
    'groupAnalysis.chooseVariablesCsv': async ([request], invocation) => {
      if (!isRecord(request))
        throw new Error('Provide a valid variables import request.')
      assertExactObjectKeys(
        request,
        ['project'],
        'the variables import request',
      )
      const session = requireProject(request.project)
      const result = await showOpenDialogFor(invocation, {
        title: 'Import a variables table',
        buttonLabel: 'Import',
        defaultPath: session.ref.root,
        properties: ['openFile', 'dontAddToRecent'],
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      })
      const path = result.canceled ? undefined : result.filePaths[0]
      if (!path) return null
      await checkChosenFile(path, {
        what: 'a variables table',
        extensions: ['.csv'],
        maxBytes: MAX_VARIABLES_CSV_BYTES,
      })
      return parseAnalysisVariableTable(
        await callProjectSidecar(session, 'groupAnalysis.importVariables', {
          path,
        }),
      )
    },
    'groupAnalysis.removeVariables': async ([request], invocation) => {
      if (!isRecord(request))
        throw new Error('Provide a valid variables removal request.')
      assertExactObjectKeys(
        request,
        ['project', 'tableId'],
        'the variables removal request',
      )
      const session = requireProject(request.project)
      if (
        typeof request.tableId !== 'string' ||
        !VARIABLE_TABLE_ID.test(request.tableId)
      ) {
        throw new Error('Provide a valid variables table ID.')
      }
      const answer = await showMessageBoxFor(invocation, {
        type: 'question',
        buttons: ['Remove', 'Keep'],
        defaultId: 1,
        cancelId: 1,
        message: 'Remove the imported variables table?',
        detail:
          'Analyses that use its columns can no longer compute until it is imported again.',
      })
      if (answer.response !== 0) return false
      await callProjectSidecar(session, 'groupAnalysis.deleteVariables', {
        tableId: request.tableId,
      })
      return true
    },
    'groupAnalysis.chooseAtlasFiles': async ([request], invocation) => {
      if (!isRecord(request))
        throw new Error('Provide a valid atlas import request.')
      assertExactObjectKeys(
        request,
        ['project', 'recipeId', 'label', 'license', 'externalSourceId'],
        'the atlas import request',
      )
      const session = requireProject(request.project)
      const recipeId = request.recipeId
      if (
        recipeId !== 'user-gcs' &&
        recipeId !== 'user-annot' &&
        recipeId !== 'user-volume'
      ) {
        throw new Error('Choose a gcs, annot, or volume atlas.')
      }
      if (
        typeof request.label !== 'string' ||
        request.label.length > 120 ||
        !/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(request.label)
      ) {
        throw new Error('Name the atlas with 1 to 120 printable characters.')
      }
      const license = request.license
      if (
        !isRecord(license) ||
        Object.keys(license).sort().join(',') !== 'name,url' ||
        typeof license.name !== 'string' ||
        license.name.trim().length === 0 ||
        license.name.length > 120 ||
        !(
          license.url === null ||
          (typeof license.url === 'string' &&
            license.url.length <= 2048 &&
            /^https:\/\/[^\s]+$/.test(license.url))
        )
      ) {
        throw new Error('Name the atlas license, with an https link or none.')
      }
      const externalSourceId = request.externalSourceId
      if (
        externalSourceId !== null &&
        !ATLAS_SOURCES.some((source) => source.sourceId === externalSourceId)
      ) {
        throw new Error('Choose a listed atlas source or none.')
      }
      const result = await showOpenDialogFor(invocation, {
        title: 'Add atlas files',
        buttonLabel: 'Add',
        properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
        filters: [
          {
            name: 'Atlas files',
            extensions: [
              ...new Set(
                ATLAS_IMPORT_EXTENSIONS[recipeId].map(
                  (extension) => extension.split('.').at(-1)!,
                ),
              ),
            ],
          },
        ],
      })
      const paths = result.canceled ? [] : result.filePaths
      if (paths.length === 0) return null
      if (paths.length > MAX_ATLAS_IMPORT_FILES) {
        throw new Error('Choose at most 8 atlas files.')
      }
      await checkChosenAtlasFiles(paths, recipeId)
      return parseAtlasImportResult(
        await callProjectSidecar(session, 'groupAnalysis.importAtlas', {
          paths,
          recipeId,
          label: request.label,
          license: { name: license.name, url: license.url },
          externalSourceId,
          machine: machineTools(services),
        }),
      )
    },
    'groupAnalysis.chooseLabelsFolder': async ([request], invocation) => {
      if (!isRecord(request))
        throw new Error('Provide a valid labels import request.')
      assertExactObjectKeys(
        request,
        ['project', 'atlasId'],
        'the labels import request',
      )
      const session = requireProject(request.project)
      if (
        typeof request.atlasId !== 'string' ||
        !ATLAS_ID.test(request.atlasId)
      ) {
        throw new Error('Provide a valid atlas ID.')
      }
      const result = await showOpenDialogFor(invocation, {
        title: 'Import labeling outputs',
        buttonLabel: 'Import',
        message: 'Choose the folder that holds one folder per subject.',
        properties: ['openDirectory', 'dontAddToRecent'],
      })
      const path = result.canceled ? undefined : result.filePaths[0]
      if (!path) return null
      await checkChosenFolder(path)
      return parseAtlasLabelsImportResult(
        await callProjectSidecar(session, 'groupAnalysis.importAtlasLabels', {
          path,
          atlasId: request.atlasId,
          machine: machineTools(services),
        }),
      )
    },
    'atlasSources.list': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for atlasSources.list.')
      return requireAtlasSources().list()
    },
    'atlasSources.download': async ([request, ...rest]) => {
      if (rest.length > 0 || !isRecord(request))
        throw new Error('Provide a valid atlas download request.')
      assertExactObjectKeys(
        request,
        ['sourceId', 'licenseAcknowledged'],
        'the atlas download request',
      )
      if (typeof request.sourceId !== 'string') {
        throw new Error('Choose a listed atlas source.')
      }
      if (request.licenseAcknowledged !== true) {
        throw new Error('Acknowledge the atlas license before downloading.')
      }
      return requireAtlasSources().download({
        sourceId: request.sourceId,
        licenseAcknowledged: true,
      })
    },
    'atlasSources.status': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for atlasSources.status.')
      return requireAtlasSources().status()
    },
    'atlasSources.cancel': async ([request, ...rest]) => {
      if (rest.length > 0 || !isRecord(request))
        throw new Error('Provide a valid atlas download cancel request.')
      assertExactObjectKeys(request, ['operationId'], 'the cancel request')
      if (
        typeof request.operationId !== 'string' ||
        !ATLAS_DOWNLOAD_OPERATION_ID.test(request.operationId)
      ) {
        throw new Error('Provide a valid atlas download operation ID.')
      }
      return requireAtlasSources().cancel({ operationId: request.operationId })
    },
    'atlasSources.openPage': async ([request, ...rest]) => {
      if (rest.length > 0 || !isRecord(request))
        throw new Error('Provide a valid atlas page request.')
      assertExactObjectKeys(
        request,
        ['sourceId', 'kind'],
        'the atlas page request',
      )
      if (
        typeof request.sourceId !== 'string' ||
        !ATLAS_SOURCE_URL_KINDS.includes(request.kind as AtlasSourceUrlKind) ||
        atlasSourceUrl(request.sourceId, request.kind) === null
      ) {
        throw new Error('Choose a listed atlas source and its page or license.')
      }
      await requireAtlasSources().openPage({
        sourceId: request.sourceId,
        kind: request.kind as AtlasSourceUrlKind,
      })
    },
    'atlasSources.chooseSubregionsPython': async (args, invocation) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for the interpreter choice.')
      const preferences = requirePreferences(services)
      const result = await showOpenDialogFor(invocation, {
        title: 'Choose the Python 3.12 interpreter for subregions',
        properties: ['openFile'],
      })
      const path = result.canceled ? undefined : result.filePaths[0]
      if (!path) return null
      // Store only an interpreter that runs as Python 3.12 with samseg's
      // modules; the chosen path is kept as given (a venv's python link).
      await checkSubregionsPython(path)
      preferences.setSubregionsPython(path)
      return path
    },
    'atlasSources.clearSubregionsPython': async (args) => {
      if (args.length !== 0)
        throw new Error('Provide valid arguments for the interpreter reset.')
      requirePreferences(services).setSubregionsPython(null)
    },
    'brainViewer.assets': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid brain asset request.')
      const hasSubject = 'subjectId' in request
      assertExactObjectKeys(
        request,
        ['project', ...(hasSubject ? ['subjectId'] : [])],
        'the brain asset request',
      )
      const session = requireProject(request.project)
      const subjectId = request.subjectId
      if (
        hasSubject &&
        (typeof subjectId !== 'string' ||
          !isSafeSegment(subjectId) ||
          subjectId.length > 128)
      ) {
        throw new Error('Provide a valid subject ID for the brain viewer.')
      }
      const assetRequest: BrainAssetsRequest = hasSubject
        ? { subjectId: subjectId as string }
        : {}
      return listBrainAssets(brainAssetContext(session), assetRequest)
    },
    'brainViewer.readAsset': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid brain asset request.')
      const hasSubject = 'subjectId' in request
      assertExactObjectKeys(
        request,
        ['project', 'assetId', ...(hasSubject ? ['subjectId'] : [])],
        'the brain asset request',
      )
      const session = requireProject(request.project)
      const assetId = request.assetId
      if (!isBrainAssetId(assetId)) {
        throw new Error('Request an allowlisted brain asset.')
      }
      const subjectId = request.subjectId
      if (isSubjectAssetId(assetId) !== hasSubject) {
        throw new Error('Name the subject for subject volumes only.')
      }
      if (
        hasSubject &&
        (typeof subjectId !== 'string' ||
          !isSafeSegment(subjectId) ||
          subjectId.length > 128)
      ) {
        throw new Error('Provide a valid subject ID for the brain viewer.')
      }
      const readRequest: BrainAssetReadRequest = hasSubject
        ? { assetId, subjectId: subjectId as string }
        : { assetId }
      return readBrainAsset(brainAssetContext(session), readRequest)
    },
    'lifecycle.respondBoundary': async ([request]) => {
      if (!isRecord(request))
        throw new Error('Provide a valid boundary response.')
      const decision = request.decision
      if (decision !== 'proceed' && decision !== 'cancel') {
        throw new Error('Provide a valid boundary decision.')
      }
      await requireLifecycle(services).respond({
        requestId: String(request.requestId ?? ''),
        decision,
        ...(typeof request.reason === 'string'
          ? { reason: request.reason }
          : {}),
      })
    },
    'window.minimize': async (_args, invocation) => {
      invokingWindow(invocation)?.minimize()
    },
    'window.toggleMaximize': async (_args, invocation) => {
      const win = invokingWindow(invocation)
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    },
    'window.close': async () =>
      requireLifecycle(services).request('window-close'),
    'window.isMaximized': async (_args, invocation) =>
      invokingWindow(invocation)?.isMaximized() ?? false,
    'update.check': async () => autoUpdate.check(),
    'update.download': async () => autoUpdate.download(),
    'update.installNow': async () =>
      requireLifecycle(services).request('update-install'),
    'update.getStatus': async () => autoUpdate.getStatus(),
  }
}

/**
 * The folders the pipeline writes, which never hold an analysis export. A
 * folder that contains the project root itself is left out, or no export
 * inside the project could be written.
 */
function pipelineWriteRoots(session: ProjectSession): string[] {
  const root = resolve(session.ref.root)
  return [
    concretePath(session.cfg, '${paths.outputDir}'),
    concretePath(session.cfg, '${outputs.runDir}'),
    concretePath(session.cfg, '${paths.derivativesDir}'),
    join(root, 'outputs', 'run'),
    join(root, 'derivatives'),
  ].filter(
    (path): path is string =>
      path !== null && relative(path, root).startsWith('..'),
  )
}

/** Bind the brain viewer's reads to one project session's roots. */
function brainAssetContext(session: ProjectSession): BrainAssetContext {
  return {
    cfg: session.cfg,
    projectRoot: session.ref.root,
    env: process.env,
    derivativesDir: concretePath(session.cfg, '${paths.derivativesDir}'),
    confineSubjectPath: (path) => validateArtifactPath(session, path),
  }
}

function requestBytes(request: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(request), 'utf8')
  } catch {
    throw new Error('Send a JSON-serializable IPC request.')
  }
}

function parseInvokeRequest(value: unknown): {
  domain: string
  method: string
  args: unknown[]
  key: string
} {
  if (!isRecord(value)) throw new Error('Provide a valid IPC request envelope.')
  const domain = value.domain
  const method = value.method
  const args = value.args
  if (
    typeof domain !== 'string' ||
    typeof method !== 'string' ||
    !/^[a-z][a-zA-Z0-9]*$/.test(domain) ||
    !/^[a-z][a-zA-Z0-9]*$/.test(method) ||
    !Array.isArray(args) ||
    args.length > 16
  ) {
    throw new Error('Provide a valid IPC request envelope.')
  }
  const key = `${domain}.${method}`
  // An export carries figures: measure it structurally against its own cap.
  const oversized =
    key === 'groupAnalysis.writeExport'
      ? boundedRequestBytes(value, MAX_EXPORT_REQUEST_BYTES) >
        MAX_EXPORT_REQUEST_BYTES
      : requestBytes(value) >
        (LARGE_ANALYSIS_REQUESTS.has(key)
          ? MAX_ANALYSIS_REQUEST_BYTES
          : MAX_REQUEST_BYTES)
  if (oversized) throw new Error('Reduce the IPC request below the size limit.')
  return { domain, method, args, key }
}

/** The exact renderer frame authorized to invoke privileged IPC. */
export interface TrustedRendererIdentity {
  /** The exact normalized renderer URL, including its root path. */
  url: string
  /** The owning BrowserWindow's WebContents identity. */
  webContentsId: number
}

/** Accept IPC only from the owning window's exact current main frame. */
export function isTrustedIpcSender(
  event: IpcMainInvokeEvent,
  trustedRenderer: TrustedRendererIdentity,
): boolean {
  const sender = event.sender
  const frame = event.senderFrame
  if (
    !Number.isSafeInteger(trustedRenderer.webContentsId) ||
    trustedRenderer.webContentsId < 1 ||
    trustedRenderer.url.length === 0 ||
    !sender ||
    sender.id !== trustedRenderer.webContentsId ||
    !frame ||
    frame !== sender.mainFrame
  ) {
    return false
  }
  const owner = BrowserWindow.fromWebContents(sender)
  return (
    owner?.webContents === sender &&
    frame.url === sender.getURL() &&
    frame.url === trustedRenderer.url
  )
}

const DRAFT_CONFIG_SIDECAR = new Set([
  'env.check',
  'env.toolStatus',
  'subjects.discover',
  'subjects.refreshOne',
])

const SAVED_CONFIG_SIDECAR = new Set([
  'env.optInInstall',
  'env.createOutputDir',
  'provision.pybrainage',
  'provision.braincharts',
  'provision.synthstrip',
  'provision.fastsurfer',
  'managedResource.status',
  'managedResource.cancel',
  'managedResource.importOffline',
  'inputFov.list',
  'inputFov.review',
  'pipeline.planWorkflow',
  'pipeline.runWorkflow',
  'pipeline.resumeWorkflow',
  'pipeline.retryWorkflow',
])

const PROJECT_REF_SIDECAR = new Set([
  'env.installStatus',
  'provision.status',
  'provision.cancel',
  'pipeline.cancelRun',
  'runtime.bootstrap',
  'manifest.forRun',
  'manifest.list',
  'manifest.previewDebug',
  'manifest.bundleDebug',
  'results.list',
  'surfaceRegistration.status',
  'surfaceRegistration.check',
  'surfaceRegistration.cancel',
  'groupAnalysis.catalog',
  'groupAnalysis.inputs',
  'groupAnalysis.start',
  'groupAnalysis.status',
  'groupAnalysis.cancel',
  'groupAnalysis.list',
  'groupAnalysis.result',
  'groupAnalysis.measureDetail',
  'groupAnalysis.saveSpec',
  'groupAnalysis.deleteSpec',
  'groupAnalysis.saveSet',
  'groupAnalysis.lockSet',
  'groupAnalysis.deleteSet',
  'groupAnalysis.termRows',
  'groupAnalysis.atlases',
  'groupAnalysis.labelStart',
  'groupAnalysis.labelStatus',
  'groupAnalysis.labelCancel',
  'groupAnalysis.clearLabels',
  'registry.list',
  'registry.upsert',
  'registry.importCsv',
  'registry.remove',
  'registry.setSite',
])

/**
 * Accept only the fields each surface-registration call takes; main adds
 * the saved configuration afterwards.
 */
function assertSurfaceRegistrationRequest(
  key: string,
  request: Record<string, unknown>,
): void {
  if (key === 'surfaceRegistration.status') {
    assertExactObjectKeys(request, ['project'], `${key} request`)
  } else if (key === 'surfaceRegistration.check') {
    assertExactObjectKeys(
      request,
      ['project', ...('retryFailed' in request ? ['retryFailed'] : [])],
      `${key} request`,
    )
    if ('retryFailed' in request && typeof request.retryFailed !== 'boolean') {
      throw new Error('Send retryFailed as true or false.')
    }
  } else {
    assertExactObjectKeys(request, ['project', 'operationId'], `${key} request`)
    if (
      typeof request.operationId !== 'string' ||
      !REGISTRATION_OPERATION_ID.test(request.operationId)
    ) {
      throw new Error('Provide a valid surface-registration operation ID.')
    }
  }
}

/** The registry writes gated on an unchanged saved project file. */
const REGISTRY_WRITE_SIDECAR = new Set([
  'registry.upsert',
  'registry.importCsv',
  'registry.remove',
  'registry.setSite',
])

async function validateConfigEnvelope(
  request: Record<string, unknown>,
  key: string,
  requireSaved: boolean,
): Promise<{ session: ProjectSession; cfg: ProjectConfig }> {
  const session = requireProject(request.project)
  const cfg = parseConfig(request.cfg, key)
  await assertConfigRoot(cfg, session.ref.root)
  if (
    !Number.isSafeInteger(request.configRevision) ||
    Number(request.configRevision) < 0
  ) {
    throw new Error(`Provide a valid configRevision for ${key}.`)
  }
  if (requireSaved) {
    if (
      request.configRevision !== session.configRevision ||
      stableConfig(cfg) !== stableConfig(session.cfg)
    ) {
      throw new Error(
        `Save the current project revision before calling ${key}.`,
      )
    }
    await assertSavedSessionCurrent(session)
  }
  return { session, cfg }
}

async function sessionForRawConfig(
  value: unknown,
): Promise<{ session: ProjectSession; cfg: ProjectConfig }> {
  const cfg = parseConfig(value, 'pipeline command preview')
  const configuredRoot = resolve(cfg.paths.projectRoot)
  const canonicalRoot = await realpath(configuredRoot).catch(
    () => configuredRoot,
  )
  const session = [...projectSessions.values()].find(
    (candidate) => candidate.ref.root === canonicalRoot,
  )
  if (!session)
    throw new Error('Open the project before sending a pipeline request.')
  await assertConfigRoot(cfg, session.ref.root)
  return { session, cfg }
}

async function prepareSidecarArgs(
  key: string,
  args: unknown[],
  senderId: number,
  userDataPath?: string,
  machine?: MachineTools,
): Promise<unknown[]> {
  if (key === 'pipeline.previewCommand') {
    await sessionForRawConfig(args[0])
    const stepKey = args[1]
    const subjectId = args[2]
    if (
      typeof stepKey !== 'string' ||
      !STEP_KEYS.includes(stepKey as StepKey)
    ) {
      throw new Error('Provide a valid step key for the command preview.')
    }
    if (
      subjectId !== undefined &&
      (typeof subjectId !== 'string' ||
        !isSafeSegment(subjectId) ||
        subjectId.length > 128)
    ) {
      throw new Error('Provide a valid subject ID for the command preview.')
    }
    return args
  }

  let request = args[0]
  let session: ProjectSession | null = null
  if (
    key === 'env.check' &&
    args.length === 1 &&
    isRecord(request) &&
    !('project' in request)
  ) {
    // Host-scoped environment check: read-only probes without a project.
    // Forward only a validated optional ids filter; no config, revision, or
    // project identity crosses this envelope, and every mutating environment
    // action keeps its project-bound envelope class.
    const typed = request as Record<string, unknown>
    if (Object.keys(typed).some((field) => field !== 'ids')) {
      throw new Error('Correct the invalid fields in the env.check request.')
    }
    const ids = typed.ids
    if (ids !== undefined) {
      if (
        !Array.isArray(ids) ||
        ids.length > 64 ||
        ids.some(
          (id) =>
            typeof id !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(id),
        )
      ) {
        throw new Error('Provide valid check ids for env.check.')
      }
    }
    return ids === undefined ? [{}] : [{ ids }]
  }
  if (
    DRAFT_CONFIG_SIDECAR.has(key) ||
    SAVED_CONFIG_SIDECAR.has(key) ||
    PROJECT_REF_SIDECAR.has(key)
  ) {
    if (args.length !== 1 || !isRecord(request)) {
      throw new Error(`Provide one project request for ${key}.`)
    }
  }
  if (DRAFT_CONFIG_SIDECAR.has(key)) {
    const validated = await validateConfigEnvelope(
      request as Record<string, unknown>,
      key,
      false,
    )
    session = validated.session
    if (key === 'subjects.refreshOne') {
      const subjectId = (request as Record<string, unknown>).subjectId
      if (
        typeof subjectId !== 'string' ||
        !isSafeSegment(subjectId) ||
        subjectId.length > 128
      ) {
        throw new Error('Provide a valid subject ID for subjects.refreshOne.')
      }
    }
  } else if (SAVED_CONFIG_SIDECAR.has(key)) {
    const validated = await validateConfigEnvelope(
      request as Record<string, unknown>,
      key,
      true,
    )
    session = validated.session
  } else if (PROJECT_REF_SIDECAR.has(key)) {
    session = requireProject((request as Record<string, unknown>).project)
    if (key.startsWith('surfaceRegistration.')) {
      assertSurfaceRegistrationRequest(key, request as Record<string, unknown>)
    }
    if (key in ATLAS_LABELING_REQUEST_FIELDS) {
      validateAtlasLabelingRequest(key, request as Record<string, unknown>)
      if (key === 'groupAnalysis.labelStart') {
        validateAnalysisStageCurrency(
          (request as Record<string, unknown>).stageCurrency,
        )
      }
    } else if (key.startsWith('groupAnalysis.')) {
      validateGroupAnalysisRequest(key, request as Record<string, unknown>)
    }
    if (REGISTRY_WRITE_SIDECAR.has(key)) {
      await assertSavedSessionCurrent(session)
    }
    if (key === 'registry.importCsv') {
      const typed = request as Record<string, unknown>
      if (
        typeof typed.csvText !== 'string' ||
        Buffer.byteLength(typed.csvText, 'utf8') > MAX_REGISTRY_IMPORT_BYTES
      ) {
        throw new Error('Provide bounded CSV text for the registry import.')
      }
      if (typed.onExisting !== 'skip' && typed.onExisting !== 'update') {
        throw new Error(
          'Choose skip or update for already-registered subjects.',
        )
      }
    }
    if (key === 'registry.setSite') {
      const typed = request as Record<string, unknown>
      assertExactObjectKeys(
        typed,
        ['project', 'subjectIds', 'site', 'expectedRevisions'],
        'registry.setSite request',
      )
      request = { project: typed.project, ...parseRegistrySetSiteFields(typed) }
    }
    request = {
      ...(request as Record<string, unknown>),
      ...(MACHINE_TOOL_SIDECAR.has(key)
        ? {
            machine: machine ?? {
              subregionsPython: null,
              atlasCacheRoot: null,
            },
          }
        : {}),
      cfg: session.cfg,
      configRevision: session.configRevision,
      configSha256: session.configSha256,
    }
    args = [request]
  }

  if (session && key.startsWith('inputFov.')) {
    const requestObject = request as Record<string, unknown>
    if (key === 'inputFov.list') {
      assertExactObjectKeys(
        requestObject,
        ['project', 'cfg', 'configRevision'],
        'inputFov.list request',
      )
    } else {
      const reviewFields = [
        'project',
        'cfg',
        'configRevision',
        'subjectId',
        'preflightSignature',
        'sourceSha256',
        'outputSha256',
        'expectedRevision',
        'decision',
      ]
      assertExactObjectKeys(
        requestObject,
        [
          ...reviewFields,
          ...(['sessionId', 'acquisitionId'] as const).filter(
            (field) => field in requestObject,
          ),
        ],
        'inputFov.review request',
      )
      const identity = parseInputFovReviewRequest({
        subjectId: requestObject.subjectId,
        ...('sessionId' in requestObject
          ? { sessionId: requestObject.sessionId }
          : {}),
        ...('acquisitionId' in requestObject
          ? { acquisitionId: requestObject.acquisitionId }
          : {}),
        preflightSignature: requestObject.preflightSignature,
        sourceSha256: requestObject.sourceSha256,
        outputSha256: requestObject.outputSha256,
        expectedRevision: requestObject.expectedRevision,
        decision: requestObject.decision,
      })
      request = {
        ...requestObject,
        ...('sessionId' in requestObject
          ? { sessionId: identity.sessionId ?? null }
          : {}),
        acquisitionId: identity.acquisitionId ?? null,
      }
      args = [request]
    }
  }

  if (
    session &&
    (key === 'provision.synthstrip' ||
      key === 'provision.fastsurfer' ||
      key.startsWith('managedResource.'))
  ) {
    const requestObject = request as Record<string, unknown>
    let resource: 'synthstrip' | 'fastsurfer'
    let variant: 'cpu' | 'cuda'
    if (key === 'provision.synthstrip') {
      assertExactObjectKeys(
        requestObject,
        ['project', 'cfg', 'configRevision', 'authorization'],
        'provision.synthstrip request',
      )
      resource = 'synthstrip'
      variant = 'cpu'
    } else if (key === 'provision.fastsurfer') {
      assertExactObjectKeys(
        requestObject,
        ['project', 'cfg', 'configRevision', 'variant', 'authorization'],
        'provision.fastsurfer request',
      )
      resource = 'fastsurfer'
      variant = parseManagedResourceRequest({
        resource,
        variant: requestObject.variant,
      }).variant
    } else {
      const operationFields =
        key === 'managedResource.cancel'
          ? ['operationId']
          : key === 'managedResource.importOffline'
            ? ['sourcePath', 'authorization']
            : []
      assertExactObjectKeys(
        requestObject,
        [
          'project',
          'cfg',
          'configRevision',
          'resource',
          'variant',
          ...operationFields,
        ],
        `${key} request`,
      )
      const parsed = parseManagedResourceRequest({
        resource: requestObject.resource,
        variant: requestObject.variant,
      })
      resource = parsed.resource
      variant = parsed.variant
      if (
        key === 'managedResource.cancel' &&
        (typeof requestObject.operationId !== 'string' ||
          !/^resource-[a-f0-9]{12}$/.test(requestObject.operationId))
      ) {
        throw new Error('Provide a valid managed-resource operation identity.')
      }
      if (key === 'managedResource.importOffline') {
        const sourcePath = requestObject.sourcePath
        if (
          typeof sourcePath !== 'string' ||
          !isAbsolute(sourcePath) ||
          sourcePath.length > 16_384
        ) {
          throw new Error(
            'Provide a valid managed-resource offline source path.',
          )
        }
        const sourceInfo = await lstat(sourcePath)
        if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
          throw new Error(
            'Select a regular file as the managed-resource offline source.',
          )
        }
      }
    }
    if (
      typeof userDataPath !== 'string' ||
      !isAbsolute(userDataPath) ||
      userDataPath.length > 16_384
    ) {
      throw new Error('Make the managed scientific-resource storage available.')
    }
    request = {
      ...requestObject,
      resource,
      variant,
      userDataPath,
    }
    args = [request]
  }

  if (session && key === 'provision.braincharts') {
    const requestObject = request as Record<string, unknown>
    assertExactObjectKeys(
      requestObject,
      ['project', 'cfg', 'configRevision', 'authorization', 'licenseAccepted'],
      'provision.braincharts request',
    )
    if (requestObject.licenseAccepted !== true) {
      throw new Error(
        'Accept the BrainCharts license notice before the download.',
      )
    }
  }
  if (session && key === 'env.createOutputDir') {
    const requestObject = request as Record<string, unknown>
    assertExactObjectKeys(
      requestObject,
      ['project', 'cfg', 'configRevision', 'checkId', 'authorization'],
      'env.createOutputDir request',
    )
    const checkId = requestObject.checkId
    if (
      typeof checkId !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(checkId)
    ) {
      throw new Error('Provide a valid check ID for env.createOutputDir.')
    }
  }
  if (
    session &&
    (key === 'env.optInInstall' || key === 'env.createOutputDir')
  ) {
    await consumeExecutionAuthorization(
      (request as Record<string, unknown>).authorization,
      'opt-in-install',
      session,
      senderId,
    )
  }
  if (
    session &&
    (key === 'provision.pybrainage' ||
      key === 'provision.braincharts' ||
      key === 'provision.synthstrip' ||
      key === 'provision.fastsurfer' ||
      key === 'managedResource.importOffline')
  ) {
    await consumeExecutionAuthorization(
      (request as Record<string, unknown>).authorization,
      'provision',
      session,
      senderId,
    )
  }
  if (
    session &&
    (key === 'pipeline.runWorkflow' ||
      key === 'pipeline.resumeWorkflow' ||
      key === 'pipeline.retryWorkflow')
  ) {
    const requestObject = request as Record<string, unknown>
    if ('runtimeContext' in requestObject) {
      throw new Error('Remove runtimeContext from renderer workflow requests.')
    }
    const dryRun = session.cfg.runtime.dryRun
    if (
      requestObject.previewOnly !== undefined &&
      typeof requestObject.previewOnly !== 'boolean'
    ) {
      throw new Error('Provide previewOnly as a boolean.')
    }
    if (
      key === 'pipeline.runWorkflow' &&
      requestObject.previewOnly !== undefined
    ) {
      throw new Error('Remove previewOnly from pipeline.runWorkflow requests.')
    }
    const previewOnly = requestObject.previewOnly === true
    const expectedPurpose: ExecutionAuthorization['purpose'] =
      key === 'pipeline.retryWorkflow' && requestObject.cleanIncomplete === true
        ? 'cleanup'
        : 'live-workflow'
    if (
      !previewOnly &&
      (!dryRun || requestObject.liveExecutionAuthorization !== undefined)
    ) {
      const approvedPlan = requestObject.approvedPlan
      if (
        !isRecord(approvedPlan) ||
        typeof approvedPlan.planId !== 'string' ||
        !/^run-[a-f0-9]{12}$/.test(approvedPlan.planId) ||
        typeof approvedPlan.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(approvedPlan.digest)
      ) {
        throw new Error(
          'Review and approve the exact workflow plan before execution.',
        )
      }
      await consumeExecutionAuthorization(
        requestObject.liveExecutionAuthorization,
        expectedPurpose,
        session,
        senderId,
        approvedPlan.digest,
      )
    }
    if (
      typeof userDataPath === 'string' &&
      isAbsolute(userDataPath) &&
      userDataPath.length <= 16_384
    ) {
      request = {
        ...requestObject,
        runtimeContext: { userDataPath },
      }
      args = [request]
    }
  }
  if (session && key === 'pipeline.planWorkflow') {
    const requestObject = request as Record<string, unknown>
    if ('runtimeContext' in requestObject) {
      throw new Error('Remove runtimeContext from renderer workflow requests.')
    }
    if (
      typeof userDataPath === 'string' &&
      isAbsolute(userDataPath) &&
      userDataPath.length <= 16_384
    ) {
      request = {
        ...requestObject,
        runtimeContext: { userDataPath },
      }
      args = [request]
    }
  }
  if (session && key === 'results.list') {
    // Sign inventory receipts with the same managed-resource runtime the
    // planner used, so a result does not read as stale for lacking the
    // SynthStrip image path that only the app knows.
    const requestObject = request as Record<string, unknown>
    if ('runtimeContext' in requestObject) {
      throw new Error('Remove runtimeContext from renderer workflow requests.')
    }
    if (
      typeof userDataPath === 'string' &&
      isAbsolute(userDataPath) &&
      userDataPath.length <= 16_384
    ) {
      request = {
        ...requestObject,
        runtimeContext: { userDataPath },
      }
      args = [request]
    }
  }
  if (key === 'manifest.bundleDebug') {
    if (!isRecord(request))
      throw new Error('Provide a valid debug bundle request.')
    if (
      request.consent !== true ||
      request.redaction !== 'required' ||
      !Array.isArray(request.categoryIds)
    ) {
      throw new Error(
        'Select explicit debug categories and confirm required redaction.',
      )
    }
    if (!session) throw new Error('Make the debug bundle project available.')
    const destinationPath = await consumeDestination(
      request.destinationId,
      senderId,
      'debug-bundle',
      session,
    )
    requireProject(session.ref)
    return [{ ...request, destinationPath }]
  }
  if (session) requireProject(session.ref)
  return args
}

/** Trusted IPC registration and optional native services. */
export interface RegisterIpcOptions {
  /** Require the exact main-frame identity for every privileged invocation. */
  trustedRenderer: TrustedRendererIdentity
  lifecycle?: LifecycleHooks
  preferences?: MachinePreferenceController
  windowPlacement?: WindowPlacementController
  thirdPartyNoticesPath?: string
  /** Electron's machine-local userData root, for managed scientific SIFs. */
  userDataPath?: string
}

/**
 * Register strict dispatch and sidecar notifications, and return a disposer.
 *
 * @returns A function that removes every registered IPC listener.
 */
export function registerIpc(
  sidecar: Sidecar,
  options: RegisterIpcOptions,
): () => void {
  const sendToTrustedRenderer = (topic: string, payload: unknown): void => {
    const win = BrowserWindow.getAllWindows().find(
      (candidate) =>
        candidate.webContents.id === options.trustedRenderer.webContentsId &&
        candidate.webContents.getURL() === options.trustedRenderer.url,
    )
    win?.webContents.send(IPC_CHANNELS.event, { topic, payload })
  }
  // Atlas downloads use Chromium's network stack (system proxy settings).
  const atlasSources = options.userDataPath
    ? new AtlasSourceManager({
        userDataPath: options.userDataPath,
        openExternal: (url) => shell.openExternal(url),
        fetch: (url, init) => net.fetch(url, init),
      })
    : null
  const native = nativeHandlers({
    sidecar,
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
    ...(options.windowPlacement
      ? { windowPlacement: options.windowPlacement }
      : {}),
    ...(options.thirdPartyNoticesPath
      ? { thirdPartyNoticesPath: options.thirdPartyNoticesPath }
      : {}),
    ...(options.userDataPath ? { userDataPath: options.userDataPath } : {}),
    ...(atlasSources ? { atlasSources } : {}),
  })
  ipcMain.handle(IPC_CHANNELS.invoke, async (event, rawRequest: unknown) => {
    try {
      if (!isTrustedIpcSender(event, options.trustedRenderer))
        throw new Error('Send IPC requests from the trusted renderer frame.')
      const request = parseInvokeRequest(rawRequest)
      const invocation = { senderId: event.sender.id }
      if (NATIVE_METHODS.has(request.key)) {
        const handler = native[request.key]
        if (!handler) throw new Error('Make the native IPC handler available.')
        return await handler(request.args, invocation)
      }
      if (!SIDECAR_METHODS.has(request.key)) {
        throw new Error('Call an allowlisted IPC method.')
      }
      const args = await prepareSidecarArgs(
        request.key,
        request.args,
        invocation.senderId,
        options.userDataPath,
        machineTools({
          ...(options.preferences ? { preferences: options.preferences } : {}),
          ...(options.userDataPath
            ? { userDataPath: options.userDataPath }
            : {}),
        }),
      )
      const rawResult = await sidecar.call(request.key, args)
      let contractResult: unknown
      try {
        contractResult = request.key.startsWith('subjects.')
          ? rawResult
          : parseSidecarRpcResult(request.key, rawResult)
      } catch (error) {
        logSidecarContractFailure(request.key, error)
        throw error
      }
      let result = parseSubjectRpcResult(request.key, contractResult)
      if (request.key === 'inputFov.list') {
        const sent = args[0]
        if (!isRecord(sent)) {
          throw new Error(
            'Retry inputFov.list with the active project identity.',
          )
        }
        const session = requireProject(sent.project)
        result = parseInputFovListRpcResult(
          result,
          session,
          invocation.senderId,
        )
        if (
          (result as InputFovListResult).configRevision !==
          session.configRevision
        ) {
          throw new Error(
            'Retry inputFov.list with the current config revision.',
          )
        }
      } else if (request.key === 'inputFov.review') {
        const sent = args[0]
        if (!isRecord(sent)) {
          throw new Error(
            'Retry inputFov.review with the active project identity.',
          )
        }
        const session = requireProject(sent.project)
        const parsed = parseInputFovReviewResult(result)
        result = parsed
        if (parsed.configRevision !== session.configRevision) {
          throw new Error(
            'Retry inputFov.review with the current config revision.',
          )
        }
      } else if (request.key === 'managedResource.status') {
        const parsed = parseManagedResourceStatusResult(result)
        const sent = args[0]
        if (
          !isRecord(sent) ||
          parsed.resource !== sent.resource ||
          parsed.variant !== sent.variant
        ) {
          throw new Error(
            'Retry managed-resource status for the requested resource identity.',
          )
        }
        result = parsed
      } else if (request.key === 'managedResource.cancel') {
        const parsed = parseManagedCancelResult(result)
        const sent = args[0]
        if (!isRecord(sent) || parsed.operationId !== sent.operationId) {
          throw new Error(
            'Retry managed-resource cancellation for the requested operation.',
          )
        }
        result = parsed
      } else if (
        request.key === 'managedResource.importOffline' ||
        request.key === 'provision.synthstrip' ||
        request.key === 'provision.fastsurfer'
      ) {
        result = parseManagedOperationResult(result)
      }
      if (request.key === 'subjects.refreshOne') {
        const sent = args[0]
        if (
          !isRecord(sent) ||
          !isRecord(result) ||
          result.id !== sent.subjectId
        ) {
          throw new Error(
            'Retry subjects.refreshOne for the requested subject identity.',
          )
        }
      }
      if (
        DRAFT_CONFIG_SIDECAR.has(request.key) ||
        SAVED_CONFIG_SIDECAR.has(request.key) ||
        PROJECT_REF_SIDECAR.has(request.key)
      ) {
        const sent = args[0]
        if (!isRecord(sent)) {
          throw new Error(
            'Retry the project-scoped runtime request with the active identity.',
          )
        }
        // A host-scoped env.check carries no project identity by design and
        // must not mark a project as attached.
        if (request.key !== 'env.check' || 'project' in sent) {
          requireProject(sent.project)
          sidecar.setProjectAttached(true)
        }
      } else if (request.key === 'pipeline.previewCommand') {
        await sessionForRawConfig(args[0])
      }
      if (request.key === 'manifest.bundleDebug' && isRecord(result)) {
        const requestObject = args[0]
        if (isRecord(requestObject)) {
          const session = requireProject(requestObject.project)
          registerArtifact(
            session,
            String(result.artifactId ?? ''),
            String(requestObject.destinationPath ?? ''),
            undefined,
            true,
            invocation.senderId,
          )
        }
      }
      return result
    } catch (error) {
      throw publicIpcError(error)
    }
  })

  sidecar.setNotificationHandler((notification: SidecarNotification) => {
    const extent = qcAuthorityInvalidation(notification.method)
    if (extent) invalidateQcAuthority(extent)
    const topic = relayTopic(notification.method)
    if (!topic) return
    const payload = parseRelayPayload(notification.method, notification.params)
    if (payload !== null) sendToTrustedRenderer(topic, payload)
  })
  sidecar.setStateHandler(() => {
    // A restarted or replaced sidecar may sign receipts differently.
    invalidateQcAuthority('all')
    const state = hostState(sidecar)
    sendToTrustedRenderer(IPC_EVENTS.hostState, state)
  })
  const disposePreferences = options.preferences?.onStateChanged((state) => {
    sendToTrustedRenderer(IPC_EVENTS.preferencesChanged, state)
  })
  const disposeWindowPlacement = options.windowPlacement?.onStateChanged(
    (state) => {
      sendToTrustedRenderer(IPC_EVENTS.windowPlacementChanged, state)
    },
  )

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.invoke)
    sidecar.setNotificationHandler(() => undefined)
    sidecar.setStateHandler(() => undefined)
    disposePreferences?.()
    disposeWindowPlacement?.()
    void atlasSources?.stopAll()
  }
}

function parseRelayPayload(method: string, value: unknown): unknown | null {
  try {
    switch (method) {
      case 'pipeline.jobUpdate':
        return parseRuntimeJob(value)
      case 'pipeline.stdout':
        return parsePipelineStdout(value)
      case 'runtime.event':
        return parseRuntimeEvent(value)
      case 'provision.progress':
        return parseProvisionProgress(value)
      case 'provision.log':
        return parseProvisionLog(value)
      case 'managedResource.progress':
        return parseManagedResourceProgress(value)
      case 'envInstall.progress':
        return parseEnvInstallState(value)
      default:
        return null
    }
  } catch {
    return null
  }
}

/**
 * Decide how much cached QC authority one sidecar notification invalidates.
 *
 * Run activity can add a run or change one; per-run fingerprints detect which.
 * A managed-resource, provisioning, or installer change can change the
 * signature of every receipt without changing any run manifest.
 *
 * @returns The extent to invalidate, or null for output-only traffic.
 */
function qcAuthorityInvalidation(method: string): 'answers' | 'all' | null {
  switch (method) {
    case 'pipeline.jobUpdate':
    case 'runtime.event':
      return 'answers'
    case 'managedResource.progress':
    case 'provision.progress':
    case 'envInstall.progress':
      return 'all'
    default:
      return null
  }
}

function relayTopic(method: string): string | null {
  switch (method) {
    case 'pipeline.jobUpdate':
      return IPC_EVENTS.jobUpdate
    case 'pipeline.stdout':
      return IPC_EVENTS.stdout
    case 'runtime.event':
      return IPC_EVENTS.runtimeEvent
    case 'provision.progress':
      return IPC_EVENTS.provisionProgress
    case 'provision.log':
      return IPC_EVENTS.provisionLog
    case 'managedResource.progress':
      return IPC_EVENTS.managedResourceProgress
    case 'envInstall.progress':
      return IPC_EVENTS.envInstallProgress
    default:
      return null
  }
}
