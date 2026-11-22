/** Runtime validation for every renderer-visible Python sidecar result. */

import type {
  CancelRunResult,
  DebugBundlePreview,
  EnvInstallState,
  ManifestPage,
  ProvisionCancelResult,
  RegistryImportIssue,
  RegistryImportResult,
  RegistryRecord,
  RegistrySetSiteResult,
  ResultAnalysisCohortChange,
  ResultAnalysisCohortReason,
  ResultArtifact,
  ResultPage,
  ResultProvenanceDetails,
  StepDescriptor,
  WorkflowPlan,
  WorkflowResult,
} from './contract'
import type {
  EnvCheck,
  EnvCreateDirResult,
  EnvReport,
  RunManifest,
  ToolStatus,
} from './types'
import {
  parseEnvInstallState,
  parseProvisionStatus,
  parseRuntimeSnapshot,
  parseWorkflowSummary,
} from './runtime-contracts'
import { parseExecutionFallback } from './execution-fallback'
import { parseUnitReuseForecast, parseUnitReuseSummary } from './unit-reuse'
import { STEP_KEYS, type StepKey } from './steps'
import { isSiteLabel, MAX_SET_SITE_SUBJECTS } from './sites'
import { BUILD_KINDS } from './build-identity'
import {
  parseSurfaceRegistrationCancelResult,
  parseSurfaceRegistrationCheckResult,
  parseSurfaceRegistrationStatus,
} from './surface-registration'
import {
  parseGroupAnalysisCancelResult,
  parseGroupAnalysisCatalog,
  parseGroupAnalysisInputs,
  parseGroupAnalysisLibrary,
  parseGroupAnalysisList,
  parseGroupAnalysisMeasureDetail,
  parseGroupAnalysisResult,
  parseGroupAnalysisStartResult,
  parseGroupAnalysisStatus,
  parseGroupAnalysisTermRows,
} from './group-analysis'
import {
  parseAtlasCatalog,
  parseAtlasLabelCancelResult,
  parseAtlasLabelStartResult,
  parseAtlasLabelStatus,
  parseAtlasLabelsCleared,
} from './atlas-labeling'

/**
 * The bounded-result policy.
 *
 * `Sidecar` refuses any protocol line over
 * `DEFAULT_MAX_PROTOCOL_LINE_BYTES`, so one result carries at most that many
 * bytes of JSON text. Derive the total budgets from that transport bound so
 * every payload the transport admits and the per-container limits allow is also
 * accepted here, while the worst-case revalidation cost stays proportional to
 * one protocol line.
 *
 * The smallest distinct JSON value plus its separator costs two bytes (`0,`),
 * so a line of `MAX_RESULT_BYTES` bytes cannot hold more than
 * `MAX_RESULT_BYTES / 2` values; the JSON-RPC envelope makes the real ceiling
 * strictly lower. One string character likewise costs at least one byte.
 */
const MAX_RESULT_BYTES = 8 * 1024 * 1024
const MAX_DEPTH = 20
const MAX_NODES = MAX_RESULT_BYTES / 2
const MAX_TOTAL_STRING_CHARACTERS = MAX_RESULT_BYTES
const MAX_ARRAY_ITEMS = 20_000
const MAX_OBJECT_FIELDS = 2_048
const MAX_STRING_CHARACTERS = 65_536
const MAX_ID_CHARACTERS = 256
const MAX_PATH_CHARACTERS = 16_384
const MAX_ROWS = 5_000
// Mirror the sidecar install manager's retained-operation bound.
const MAX_INSTALL_OPERATIONS = 64
const SHA256 = /^[a-f0-9]{64}$/
const STEP_KEY_SET = new Set<string>(STEP_KEYS)
const STEP_IDS: Readonly<Record<StepKey, number>> = {
  brainfov: -1,
  deface: 0,
  recon: 1,
  enigma: 2,
  outliers: 2.5,
  features: 3,
  age: 4,
  pybrainage: 5,
  clinical: 6,
  brainpad: 7,
  aggregate: 8,
  final: 9,
  braincharts: 5.5,
  zstats: 9.5,
}

/** Sidecar methods exposed through the renderer bridge. */
export const SIDECAR_RPC_RESULT_METHODS: ReadonlySet<string> = new Set([
  'env.check',
  'env.optInInstall',
  'env.installStatus',
  'env.createOutputDir',
  'env.toolStatus',
  'provision.pybrainage',
  'provision.braincharts',
  'provision.synthstrip',
  'provision.fastsurfer',
  'provision.status',
  'provision.cancel',
  'managedResource.status',
  'managedResource.cancel',
  'managedResource.importOffline',
  'inputFov.list',
  'inputFov.review',
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
  'subjects.discover',
  'subjects.refreshOne',
  'pipeline.listSteps',
  'pipeline.previewCommand',
  'pipeline.planWorkflow',
  'pipeline.runWorkflow',
  'pipeline.resumeWorkflow',
  'pipeline.retryWorkflow',
  'pipeline.cancelRun',
  'runtime.bootstrap',
  'manifest.forRun',
  'manifest.list',
  'manifest.previewDebug',
  'manifest.bundleDebug',
  'results.list',
  'registry.list',
  'registry.upsert',
  'registry.importCsv',
  'registry.remove',
  'registry.setSite',
] as const)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(
  value: unknown,
  label: string,
  maximum = MAX_STRING_CHARACTERS,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new TypeError(`Provide a bounded ${label}.`)
  }
  return value
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  target: Record<string, unknown>,
  maximum = MAX_STRING_CHARACTERS,
): void {
  if (key in source) {
    target[key] = boundedString(source[key], key, maximum, true)
  }
}

function identifier(value: unknown, label: string): string {
  return boundedString(value, label, MAX_ID_CHARACTERS)
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label)
}

function nullableString(
  value: unknown,
  label: string,
  maximum = MAX_STRING_CHARACTERS,
): string | null {
  return value === null ? null : boundedString(value, label, maximum, true)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Provide a finite ${label}.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`Set ${label} to a non-negative safe integer.`)
  }
  return Number(value)
}

function siteLabel(value: unknown, label: string): string {
  if (!isSiteLabel(value)) {
    throw new TypeError(`Provide a valid ${label}.`)
  }
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Set ${label} to true or false.`)
  }
  return value
}

function oneOf<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new TypeError(`Provide a supported ${label}.`)
  }
  return value as T
}

function stepKey(value: unknown): StepKey {
  if (typeof value !== 'string' || !STEP_KEY_SET.has(value)) {
    throw new TypeError('Provide a supported pipeline step key.')
  }
  return value as StepKey
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`Provide a valid ${label} SHA-256.`)
  }
  return value
}

function subjectIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ROWS) {
    throw new TypeError(`Provide a bounded ${label}.`)
  }
  const parsed = value.map((entry) => identifier(entry, `${label} entry`))
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`Provide unique entries in ${label}.`)
  }
  return parsed
}

function parseProjectRef(value: unknown): {
  projectId: string
  root: string
  configPath: string
  epoch: number
} {
  if (!isRecord(value)) throw new TypeError('Provide a valid project identity.')
  return {
    projectId: identifier(value.projectId, 'project ID'),
    root: boundedString(value.root, 'project root', MAX_PATH_CHARACTERS),
    configPath: boundedString(
      value.configPath,
      'project configuration path',
      MAX_PATH_CHARACTERS,
    ),
    epoch: nonNegativeInteger(value.epoch, 'project epoch'),
  }
}

function boundedJson(
  value: unknown,
  state = { nodes: 0, characters: 0 },
  depth = 0,
): unknown {
  state.nodes += 1
  if (depth > MAX_DEPTH) {
    throw new TypeError('Keep the sidecar result within its nesting limit.')
  }
  if (state.nodes > MAX_NODES) {
    throw new TypeError('Keep the sidecar result within structural bounds.')
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return finiteNumber(value, 'sidecar result number')
  }
  if (typeof value === 'string') {
    state.characters += value.length
    if (state.characters > MAX_TOTAL_STRING_CHARACTERS) {
      throw new TypeError(
        'Keep the sidecar result within its total text limit.',
      )
    }
    return boundedString(
      value,
      'sidecar result string',
      MAX_STRING_CHARACTERS,
      true,
    )
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new TypeError('Keep sidecar result arrays within the item limit.')
    }
    return value.map((entry) => boundedJson(entry, state, depth + 1))
  }
  if (!isRecord(value)) {
    throw new TypeError('Return only bounded JSON data from the sidecar.')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_OBJECT_FIELDS) {
    throw new TypeError('Keep sidecar result objects within the field limit.')
  }
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      boundedString(key, 'sidecar result field', MAX_ID_CHARACTERS),
      boundedJson(entry, state, depth + 1),
    ]),
  )
}

function parseEnvironmentReport(value: unknown): EnvReport {
  if (
    !isRecord(value) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 256
  ) {
    throw new TypeError('Provide a bounded environment report.')
  }
  return {
    groups: value.groups.map((group) => {
      if (
        !isRecord(group) ||
        !Array.isArray(group.checks) ||
        group.checks.length > 512
      ) {
        throw new TypeError('Provide a bounded environment group.')
      }
      return {
        name: boundedString(group.name, 'environment group name', 256),
        checks: group.checks.map((check) => {
          if (!isRecord(check)) {
            throw new TypeError('Provide a valid environment check.')
          }
          const parsed: EnvCheck = {
            id: identifier(check.id, 'environment check ID'),
            label: boundedString(check.label, 'environment check label', 512),
            status: oneOf(
              check.status,
              new Set([
                'found',
                'missing',
                'wrong',
                'warn',
                'skipped',
              ] as const),
              'environment check status',
            ),
          }
          const target = parsed as unknown as Record<string, unknown>
          optionalString(check, 'detail', target, 8_192)
          optionalString(check, 'recommendedCmd', target, 65_536)
          optionalString(check, 'downloadUrl', target, 4_096)
          if ('installable' in check) {
            parsed.installable = booleanValue(
              check.installable,
              'environment check installable state',
            )
          }
          if ('offlineInstall' in check) {
            parsed.offlineInstall = booleanValue(
              check.offlineInstall,
              'environment check offline-install state',
            )
          }
          if ('action' in check) {
            const action = check.action
            if (!isRecord(action)) {
              throw new TypeError('Provide a valid environment check action.')
            }
            parsed.action = {
              kind: oneOf(
                action.kind,
                new Set(['create-directory', 'setup-pybrainage'] as const),
                'environment check action kind',
              ),
              label: boundedString(
                action.label,
                'environment check action label',
                256,
              ),
            }
          }
          return parsed
        }),
      }
    }),
    availableMemoryGB:
      value.availableMemoryGB === null
        ? null
        : finiteNumber(value.availableMemoryGB, 'available memory value'),
    capturedAt: boundedString(
      value.capturedAt,
      'environment capture time',
      256,
    ),
  }
}

function parseEnvInstallStatus(value: unknown): {
  operations: EnvInstallState[]
} {
  if (
    !isRecord(value) ||
    !Array.isArray(value.operations) ||
    value.operations.length > MAX_INSTALL_OPERATIONS
  ) {
    throw new TypeError('Provide a bounded installation status.')
  }
  return { operations: value.operations.map(parseEnvInstallState) }
}

function parseEnvCreateDirResult(value: unknown): EnvCreateDirResult {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid directory-creation result.')
  }
  return {
    ok: booleanValue(value.ok, 'directory-creation outcome'),
    detail: boundedString(value.detail, 'directory-creation detail', 8_192),
  }
}

function parseToolStatus(value: unknown): ToolStatus {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 512
  ) {
    throw new TypeError('Provide a bounded tool status.')
  }
  return {
    items: value.items.map((item) => {
      if (!isRecord(item))
        throw new TypeError('Provide a valid tool status item.')
      return {
        id: identifier(item.id, 'tool status ID'),
        label: boundedString(item.label, 'tool status label', 512),
        status: oneOf(
          item.status,
          new Set(['ok', 'warn', 'missing', 'na'] as const),
          'tool status value',
        ),
      }
    }),
    summary: oneOf(
      value.summary,
      new Set(['ok', 'warn', 'missing'] as const),
      'tool summary',
    ),
    capturedAt: boundedString(value.capturedAt, 'tool capture time', 256),
  }
}

function parseOperationResult(value: unknown): { operationId: string } {
  if (!isRecord(value)) throw new TypeError('Provide a valid operation result.')
  const operationId = identifier(value.operationId, 'operation ID')
  if (!/^(?:provision|resource|install)-[a-f0-9]{12}$/.test(operationId)) {
    throw new TypeError('Provide a canonical operation ID.')
  }
  return { operationId }
}

function parseCancelResult(value: unknown): ProvisionCancelResult {
  if (!isRecord(value))
    throw new TypeError('Provide a valid cancellation result.')
  return {
    operationId: parseOperationResult({ operationId: value.operationId })
      .operationId,
    accepted: booleanValue(value.accepted, 'cancellation acceptance'),
    terminal: booleanValue(value.terminal, 'cancellation terminal state'),
  }
}

function parseStepDescriptors(value: unknown): StepDescriptor[] {
  if (!Array.isArray(value) || value.length !== STEP_KEYS.length) {
    throw new TypeError('Return one descriptor for every pipeline step.')
  }
  const parsed = value.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.dependencies)) {
      throw new TypeError('Provide a valid pipeline step descriptor.')
    }
    const key = stepKey(entry.key)
    const id = finiteNumber(entry.id, 'pipeline step ID')
    if (id !== STEP_IDS[key]) {
      throw new TypeError('Keep pipeline step IDs aligned with their keys.')
    }
    return {
      id,
      key,
      name: boundedString(entry.name, 'pipeline step name', 512),
      goal: boundedString(entry.goal, 'pipeline step goal', 4_096),
      scope: oneOf(
        entry.scope,
        new Set(['subject', 'cohort'] as const),
        'pipeline step scope',
      ),
      dependencies: entry.dependencies.map(stepKey),
    }
  })
  if (
    new Set(parsed.map(({ id }) => id)).size !== parsed.length ||
    new Set(parsed.map(({ key }) => key)).size !== parsed.length
  ) {
    throw new TypeError('Keep pipeline step identities unique.')
  }
  return parsed
}

function parseCohortIdentity(
  value: unknown,
  label: string,
): {
  subjectIds: string[]
  sha256: string
} {
  if (!isRecord(value)) throw new TypeError(`Provide a valid ${label}.`)
  return {
    subjectIds: subjectIds(value.subjectIds, `${label} subject list`),
    sha256: sha256(value.sha256, label),
  }
}

function parseWorkflowNode(value: unknown): WorkflowPlan['nodes'][number] {
  if (!isRecord(value) || !Array.isArray(value.dependencies)) {
    throw new TypeError('Provide a valid workflow node.')
  }
  const parsed = {
    nodeId: identifier(value.nodeId, 'workflow node ID'),
    stepKey: stepKey(value.stepKey),
    scope: oneOf(
      value.scope,
      new Set(['subject', 'cohort'] as const),
      'workflow node scope',
    ),
    subjectId: nullableIdentifier(value.subjectId, 'workflow subject ID'),
    status: oneOf(
      value.status,
      new Set([
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
        'persistence-error',
        'unknown',
        'skipped',
      ] as const),
      'workflow node status',
    ),
    dependencies: value.dependencies.map((entry) =>
      identifier(entry, 'workflow dependency ID'),
    ),
  } as WorkflowPlan['nodes'][number]
  if ('reason' in value) {
    parsed.reason = boundedString(
      value.reason,
      'workflow node reason',
      8_192,
      true,
    )
  }
  if ('command' in value) {
    parsed.command = boundedString(
      value.command,
      'workflow node command',
      65_536,
      true,
    )
  }
  return parsed
}

function parseWorkflowPlan(value: unknown): WorkflowPlan {
  if (
    !isRecord(value) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 20_000 ||
    !Array.isArray(value.blockers) ||
    value.blockers.length > 20_000
  ) {
    throw new TypeError('Provide a bounded workflow plan.')
  }
  const parsed: WorkflowPlan = {
    planId: identifier(value.planId, 'workflow plan ID'),
    analysisCohort: parseCohortIdentity(
      value.analysisCohort,
      'analysis cohort',
    ),
    selectedSubset: parseCohortIdentity(
      value.selectedSubset,
      'selected subset',
    ),
    nodes: value.nodes.map(parseWorkflowNode),
    blockers: value.blockers.map((blocker) => {
      if (!isRecord(blocker))
        throw new TypeError('Provide a valid stage blocker.')
      const parsedBlocker = {
        key: stepKey(blocker.key),
        reason: boundedString(blocker.reason, 'stage blocker reason', 8_192),
      } as WorkflowPlan['blockers'][number]
      if ('kind' in blocker) {
        parsedBlocker.kind = oneOf(
          blocker.kind,
          new Set([
            'config',
            'environment',
            'dependency',
            'cohort',
            'input-qc',
            'safety',
            'persistence',
            'runtime',
            'integrity',
          ] as const),
          'stage blocker kind',
        )
      }
      if ('action' in blocker) {
        parsedBlocker.action = boundedString(
          blocker.action,
          'stage blocker action',
          4_096,
          true,
        )
      }
      if ('subjects' in blocker) {
        parsedBlocker.subjects = subjectIds(
          blocker.subjects,
          'stage blocker subjects',
        )
      }
      if ('subjectCount' in blocker) {
        parsedBlocker.subjectCount = nonNegativeInteger(
          blocker.subjectCount,
          'the stage blocker subject count',
        )
      }
      return parsedBlocker
    }),
    summary: parseWorkflowSummary(value.summary),
  }
  const target = parsed as unknown as Record<string, unknown>
  for (const key of [
    'digest',
    'configDigest',
    'qcDigest',
    'registryDigest',
    'environmentDigest',
  ]) {
    if (key in value) target[key] = sha256(value[key], key)
  }
  if ('advisories' in value) {
    if (!Array.isArray(value.advisories) || value.advisories.length > 64) {
      throw new TypeError('Provide bounded workflow advisories.')
    }
    parsed.advisories = value.advisories.map((advisory) =>
      boundedString(advisory, 'workflow advisory', 4_096),
    )
  }
  if ('unitReuse' in value) {
    if (!Array.isArray(value.unitReuse) || value.unitReuse.length > 64) {
      throw new TypeError('Provide a bounded per-subject reuse forecast.')
    }
    parsed.unitReuse = value.unitReuse.map((entry) =>
      parseUnitReuseForecast(entry),
    )
  }
  if ('exclusions' in value) {
    if (!isRecord(value.exclusions)) {
      throw new TypeError('Provide valid workflow exclusions.')
    }
    parsed.exclusions = {
      qcFailedSubjectIds: subjectIds(
        value.exclusions.qcFailedSubjectIds,
        'QC-failed exclusions',
      ),
      configExcludedSubjectIds: subjectIds(
        value.exclusions.configExcludedSubjectIds,
        'configured exclusions',
      ),
    }
  }
  if ('resources' in value) {
    if (!isRecord(value.resources)) {
      throw new TypeError('Provide valid workflow resource guidance.')
    }
    parsed.resources = {
      queueSize: nonNegativeInteger(value.resources.queueSize, 'queue size'),
      availableMemoryGB:
        value.resources.availableMemoryGB === null
          ? null
          : finiteNumber(value.resources.availableMemoryGB, 'available memory'),
      memoryWarningGB: finiteNumber(
        value.resources.memoryWarningGB,
        'memory warning threshold',
      ),
      lowMemory: booleanValue(value.resources.lowMemory, 'low-memory state'),
    }
  }
  if ('selectionReconciliation' in value) {
    if (!isRecord(value.selectionReconciliation)) {
      throw new TypeError('Provide valid selection reconciliation.')
    }
    const source = value.selectionReconciliation
    parsed.selectionReconciliation = {
      sourceSubjectIds: subjectIds(source.sourceSubjectIds, 'source subjects'),
      currentEligibleSubjectIds: subjectIds(
        source.currentEligibleSubjectIds,
        'eligible subjects',
      ),
      retainedSubjectIds: subjectIds(
        source.retainedSubjectIds,
        'retained subjects',
      ),
      addedSubjectIds: subjectIds(source.addedSubjectIds, 'added subjects'),
      removedSubjectIds: subjectIds(
        source.removedSubjectIds,
        'removed subjects',
      ),
      ...(source.deferredAndUnreviewedSubjectIds === undefined
        ? {}
        : {
            deferredAndUnreviewedSubjectIds: subjectIds(
              source.deferredAndUnreviewedSubjectIds,
              'deferred subjects',
            ),
          }),
    }
  }
  return parsed
}

function parseWorkflowResult(value: unknown): WorkflowResult {
  if (!isRecord(value)) throw new TypeError('Provide a valid workflow result.')
  return {
    runId: nullableIdentifier(value.runId, 'workflow run ID'),
    disposition: oneOf(
      value.disposition,
      new Set(['started', 'planned', 'noop', 'blocked'] as const),
      'workflow disposition',
    ),
    plan: parseWorkflowPlan(value.plan),
    summary: parseWorkflowSummary(value.summary),
  }
}

function parseCancelRun(value: unknown): CancelRunResult {
  if (!isRecord(value) || !Array.isArray(value.pendingJobIds)) {
    throw new TypeError('Provide a valid run cancellation result.')
  }
  if (value.pendingJobIds.length > 20_000) {
    throw new TypeError('Keep pending job IDs within the item limit.')
  }
  return {
    runId: identifier(value.runId, 'cancelled run ID'),
    accepted: booleanValue(value.accepted, 'run cancellation acceptance'),
    terminal: booleanValue(value.terminal, 'run terminal state'),
    pendingJobIds: value.pendingJobIds.map((entry) =>
      identifier(entry, 'pending job ID'),
    ),
    message: boundedString(
      value.message,
      'run cancellation message',
      8_192,
      true,
    ),
  }
}

function parseManifest(value: unknown): RunManifest {
  if (
    !isRecord(value) ||
    !Array.isArray(value.steps) ||
    value.steps.length > STEP_KEYS.length
  ) {
    throw new TypeError('Provide a bounded run manifest.')
  }
  if (!isRecord(value.git) || !isRecord(value.tools)) {
    throw new TypeError('Provide manifest Git and tool evidence.')
  }
  const tools = Object.entries(value.tools)
  if (tools.length > 512) throw new TypeError('Keep manifest tools bounded.')
  const parsed: RunManifest = {
    runId: identifier(value.runId, 'manifest run ID'),
    startedAt: boundedString(value.startedAt, 'manifest start time', 256),
    endedAt: nullableString(value.endedAt, 'manifest end time', 256),
    user: boundedString(value.user, 'manifest user', 512, true),
    host: boundedString(value.host, 'manifest host', 512, true),
    git: {
      repo: boundedString(value.git.repo, 'manifest repository', 4_096, true),
      sha: boundedString(value.git.sha, 'manifest commit', 128, true),
      dirty: booleanValue(value.git.dirty, 'manifest dirty state'),
    },
    configSha256: sha256(value.configSha256, 'manifest configuration'),
    steps: value.steps.map((entry) => {
      if (!isRecord(entry))
        throw new TypeError('Provide a valid manifest step.')
      const key = stepKey(entry.key)
      const id = finiteNumber(entry.id, 'manifest step ID')
      if (id !== STEP_IDS[key]) {
        throw new TypeError('Keep manifest step IDs aligned with their keys.')
      }
      return {
        id,
        key,
        status: oneOf(
          entry.status,
          new Set([
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
            'persistence-error',
            'unknown',
            'skipped',
          ] as const),
          'manifest step status',
        ),
        subjects: nonNegativeInteger(entry.subjects, 'manifest subject count'),
        failed: nonNegativeInteger(entry.failed, 'manifest failed count'),
        durationSec: nonNegativeInteger(entry.durationSec, 'manifest duration'),
      }
    }),
    tools: Object.fromEntries(
      tools.map(([key, entry]) => [
        boundedString(key, 'manifest tool ID', MAX_ID_CHARACTERS),
        boundedString(entry, 'manifest tool identity', 4_096, true),
      ]),
    ),
  }
  if ('schemaVersion' in value) {
    parsed.schemaVersion = nonNegativeInteger(
      value.schemaVersion,
      'manifest schema version',
    )
  }
  if ('project' in value) parsed.project = parseProjectRef(value.project)
  if ('product' in value) {
    if (!isRecord(value.product)) {
      throw new TypeError('Provide a valid manifest product identity.')
    }
    parsed.product = {
      name: boundedString(value.product.name, 'manifest product name', 256),
      version: boundedString(
        value.product.version,
        'manifest product version',
        256,
      ),
      ...('build' in value.product
        ? {
            build: oneOf(
              value.product.build,
              new Set(BUILD_KINDS),
              'manifest build kind',
            ),
          }
        : {}),
    }
  }
  if ('intent' in value) {
    parsed.intent = oneOf(
      value.intent,
      new Set(['workflow', 'stage', 'resume', 'retry'] as const),
      'manifest intent',
    )
  }
  if ('analysisCohort' in value) {
    parsed.analysisCohort = parseCohortIdentity(
      value.analysisCohort,
      'manifest analysis cohort',
    )
  }
  if ('selectedSubset' in value) {
    parsed.selectedSubset = parseCohortIdentity(
      value.selectedSubset,
      'manifest selected subset',
    )
  }
  if ('dryRun' in value)
    parsed.dryRun = booleanValue(value.dryRun, 'manifest dryRun')
  if ('graph' in value) {
    if (!isRecord(value.graph))
      throw new TypeError('Provide a valid manifest graph.')
    parsed.graph = {
      nodes: nonNegativeInteger(value.graph.nodes, 'manifest node count'),
      edges: nonNegativeInteger(value.graph.edges, 'manifest edge count'),
      terminal: nonNegativeInteger(
        value.graph.terminal,
        'manifest terminal count',
      ),
      blocked: nonNegativeInteger(
        value.graph.blocked,
        'manifest blocked count',
      ),
    }
  }
  if ('failurePolicy' in value) {
    if (!isRecord(value.failurePolicy)) {
      throw new TypeError('Provide a valid manifest failure policy.')
    }
    parsed.failurePolicy = {
      stopOnError: booleanValue(
        value.failurePolicy.stopOnError,
        'stop-on-error',
      ),
      continueIndependentAfterError: booleanValue(
        value.failurePolicy.continueIndependentAfterError,
        'continue-independent state',
      ),
    }
  }
  if ('recovery' in value) {
    if (!isRecord(value.recovery)) {
      throw new TypeError('Provide valid manifest recovery evidence.')
    }
    parsed.recovery = {
      state: oneOf(
        value.recovery.state,
        new Set(['current', 'interrupted', 'reconciled', 'unknown'] as const),
        'manifest recovery state',
      ),
      ...(value.recovery.detail === undefined
        ? {}
        : {
            detail: boundedString(
              value.recovery.detail,
              'manifest recovery detail',
              8_192,
              true,
            ),
          }),
    }
  }
  return parsed
}

function parseManifestPage(value: unknown): ManifestPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 500
  ) {
    throw new TypeError('Provide a bounded manifest page.')
  }
  return {
    items: value.items.map(parseManifest),
    nextCursor: nullableString(value.nextCursor, 'manifest cursor', 256),
  }
}

function parseDebugPreview(value: unknown): DebugBundlePreview {
  if (
    !isRecord(value) ||
    !Array.isArray(value.categories) ||
    value.categories.length > 64
  ) {
    throw new TypeError('Provide a bounded debug-bundle preview.')
  }
  return {
    runId: identifier(value.runId, 'debug run ID'),
    categories: value.categories.map((category) => {
      if (!isRecord(category) || !Array.isArray(category.redactions)) {
        throw new TypeError('Provide a valid debug-bundle category.')
      }
      if (category.redactions.length > 64) {
        throw new TypeError('Keep debug redactions bounded.')
      }
      return {
        id: identifier(category.id, 'debug category ID'),
        label: boundedString(category.label, 'debug category label', 512),
        fileCount: nonNegativeInteger(category.fileCount, 'debug file count'),
        estimatedBytes: nonNegativeInteger(
          category.estimatedBytes,
          'debug estimated bytes',
        ),
        redactions: category.redactions.map((entry) =>
          boundedString(entry, 'debug redaction', 512),
        ),
        truncated: booleanValue(
          category.truncated,
          'debug category truncation',
        ),
      }
    }),
    totalFiles: nonNegativeInteger(value.totalFiles, 'debug total files'),
    estimatedBytes: nonNegativeInteger(
      value.estimatedBytes,
      'debug estimated bytes',
    ),
    redactionPolicy: boundedString(
      value.redactionPolicy,
      'debug redaction policy',
      4_096,
    ),
    truncated: booleanValue(value.truncated, 'debug preview truncation'),
  }
}

function parseResultArtifact(value: unknown): ResultArtifact {
  if (!isRecord(value)) throw new TypeError('Provide a valid result artifact.')
  const parsed: ResultArtifact = {
    artifactId: identifier(value.artifactId, 'result artifact ID'),
    label: boundedString(value.label, 'result label', 1_024),
    stepKey: stepKey(value.stepKey),
    subjectId: nullableIdentifier(value.subjectId, 'result subject ID'),
    kind: oneOf(
      value.kind,
      new Set([
        'dir',
        'csv',
        'png',
        'html',
        'xlsx',
        'pdf',
        'txt',
        'nii',
      ] as const),
      'result kind',
    ),
    presence: oneOf(
      value.presence,
      new Set([
        'expected',
        'produced',
        'absent',
        'partial',
        'unknown',
      ] as const),
      'result presence',
    ),
    displayPath: boundedString(
      value.displayPath,
      'result display path',
      MAX_PATH_CHARACTERS,
      true,
    ),
    exists: booleanValue(value.exists, 'result existence'),
    openable: booleanValue(value.openable, 'result openable state'),
    revealable: booleanValue(value.revealable, 'result revealable state'),
    runId: nullableIdentifier(value.runId, 'result run ID'),
    producerNodeId: nullableIdentifier(
      value.producerNodeId,
      'producer node ID',
    ),
    receiptSha256:
      value.receiptSha256 === null
        ? null
        : sha256(value.receiptSha256, 'result receipt'),
    provenance: oneOf(
      value.provenance,
      new Set(['current', 'stale', 'unknown'] as const),
      'result provenance',
    ),
  }
  if ('provenanceDetails' in value) {
    parsed.provenanceDetails = parseResultProvenanceDetails(
      value.provenanceDetails,
    )
  }
  if ('detail' in value) {
    parsed.detail = boundedString(value.detail, 'result detail', 8_192, true)
  }
  return parsed
}

function parseResultProvenanceDetails(
  value: unknown,
): ResultProvenanceDetails | null {
  if (value === null) return null
  if (!isRecord(value)) {
    throw new TypeError('Provide valid result provenance details.')
  }
  let receipt: ResultProvenanceDetails['receipt'] = null
  if (value.receipt !== null) {
    if (!isRecord(value.receipt)) {
      throw new TypeError('Provide valid result receipt provenance.')
    }
    const source = value.receipt
    if (
      !Array.isArray(source.upstreamSignatures) ||
      source.upstreamSignatures.length > 512
    ) {
      throw new TypeError('Provide bounded upstream receipt signatures.')
    }
    receipt = {
      receiptVersion:
        source.receiptVersion === null
          ? null
          : nonNegativeInteger(source.receiptVersion, 'receipt version'),
      signature: boundedString(
        source.signature,
        'receipt signature',
        512,
        true,
      ),
      signatureValid: booleanValue(
        source.signatureValid,
        'receipt signature state',
      ),
      committedAtMs:
        source.committedAtMs === null
          ? null
          : nonNegativeInteger(source.committedAtMs, 'receipt commit time'),
      jobId: nullableString(source.jobId, 'receipt job ID', MAX_ID_CHARACTERS),
      analysisCohortDigest: nullableString(
        source.analysisCohortDigest,
        'analysis cohort digest',
        512,
      ),
      selectedSubsetDigest: nullableString(
        source.selectedSubsetDigest,
        'selected subset digest',
        512,
      ),
      inputT1Fingerprint: nullableString(
        source.inputT1Fingerprint,
        'input T1 fingerprint',
        512,
      ),
      stepParamsDigest: nullableString(
        source.stepParamsDigest,
        'step parameters digest',
        512,
      ),
      adapterIdentity: nullableString(
        source.adapterIdentity,
        'adapter identity',
        512,
      ),
      adapterImplementationSha256: nullableString(
        source.adapterImplementationSha256,
        'adapter implementation digest',
        512,
      ),
      toolEvidenceDigest: nullableString(
        source.toolEvidenceDigest,
        'tool evidence digest',
        512,
      ),
      externalInputsDigest: nullableString(
        source.externalInputsDigest,
        'external inputs digest',
        512,
      ),
      outputSchemaIdentity: nullableString(
        source.outputSchemaIdentity,
        'output schema identity',
        512,
      ),
      upstreamSignatures: source.upstreamSignatures.map((entry) =>
        boundedString(entry, 'upstream receipt signature', 512),
      ),
      baselineDigest: nullableString(
        source.baselineDigest,
        'baseline digest',
        512,
      ),
    }
    if ('executionFallback' in source) {
      receipt.executionFallback =
        source.executionFallback === null
          ? null
          : parseExecutionFallback(
              source.executionFallback,
              'receipt execution fallback',
            )
    }
    if ('unitReuse' in source) {
      receipt.unitReuse =
        source.unitReuse === null
          ? null
          : parseUnitReuseSummary(source.unitReuse, 'receipt per-subject reuse')
    }
  }
  let runBinding: ResultProvenanceDetails['runBinding'] = null
  if (value.runBinding !== null) {
    if (!isRecord(value.runBinding)) {
      throw new TypeError('Provide valid result run-binding provenance.')
    }
    const source = value.runBinding
    runBinding = {
      planDigest: nullableString(source.planDigest, 'plan digest', 512),
      configDigest: nullableString(source.configDigest, 'config digest', 512),
      qcDigest: nullableString(source.qcDigest, 'QC digest', 512),
      registryDigest: nullableString(
        source.registryDigest,
        'registry digest',
        512,
      ),
      environmentDigest: nullableString(
        source.environmentDigest,
        'environment digest',
        512,
      ),
    }
  }
  return { receipt, runBinding }
}

function parseResultPage(value: unknown): ResultPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 500
  ) {
    throw new TypeError('Provide a bounded result page.')
  }
  const parsed: ResultPage = {
    items: value.items.map(parseResultArtifact),
    nextCursor: nullableString(value.nextCursor, 'result cursor', 256),
    truncated: booleanValue(value.truncated, 'result truncation'),
  }
  if ('runId' in value)
    parsed.runId = nullableIdentifier(value.runId, 'result run ID')
  if ('configSha256' in value) {
    parsed.configSha256 =
      value.configSha256 === null
        ? null
        : sha256(value.configSha256, 'result configuration')
  }
  if ('total' in value)
    parsed.total = nonNegativeInteger(value.total, 'result total')
  if ('producedStepKeys' in value) {
    if (
      !Array.isArray(value.producedStepKeys) ||
      value.producedStepKeys.length > STEP_KEYS.length
    ) {
      throw new TypeError('Provide valid produced result steps.')
    }
    parsed.producedStepKeys = value.producedStepKeys.map(stepKey)
  }
  if ('stageCurrency' in value) {
    parsed.stageCurrency = parseStageCurrency(value.stageCurrency)
  }
  if ('analysisCohortChange' in value) {
    parsed.analysisCohortChange = parseAnalysisCohortChange(
      value.analysisCohortChange,
    )
  }
  return parsed
}

const STAGE_CURRENCY_STATES = new Set([
  'current',
  'outdated',
  'unknown',
] as const)

const STAGE_CURRENCY_CAUSES = new Set(['analysis-cohort'] as const)

const ANALYSIS_COHORT_CHANGE_CAUSES = new Set(['membership'] as const)

const ANALYSIS_COHORT_REASON_KINDS = new Set([
  'subjects-added',
  'subjects-removed',
  'config-exclusion',
  't1-changed',
  'qc-exclusion',
] as const)

/** Subjects the sidecar names per analysis-cohort reason. */
const MAX_REASON_SUBJECTS = 20

function parseAnalysisCohortReasons(
  value: unknown,
): ResultAnalysisCohortReason[] {
  if (
    !Array.isArray(value) ||
    value.length > ANALYSIS_COHORT_REASON_KINDS.size
  ) {
    throw new TypeError('Provide valid analysis-cohort change reasons.')
  }
  const reasons = value.map((entry): ResultAnalysisCohortReason => {
    if (!isRecord(entry)) {
      throw new TypeError('Provide valid analysis-cohort change reasons.')
    }
    const subjects = subjectIds(entry.subjectIds, 'analysis-cohort reason')
    const count = nonNegativeInteger(
      entry.count,
      'analysis-cohort reason count',
    )
    // The sidecar names every subject up to the bound, and counts the rest.
    if (subjects.length !== Math.min(count, MAX_REASON_SUBJECTS)) {
      throw new TypeError('Provide a bounded analysis-cohort reason.')
    }
    return {
      kind: oneOf(
        entry.kind,
        ANALYSIS_COHORT_REASON_KINDS,
        'analysis-cohort reason',
      ),
      subjectIds: subjects,
      count,
    }
  })
  if (new Set(reasons.map((reason) => reason.kind)).size !== reasons.length) {
    throw new TypeError('Provide each analysis-cohort reason once.')
  }
  return reasons
}

function parseAnalysisCohortChange(
  value: unknown,
): ResultAnalysisCohortChange | null {
  if (value === null) return null
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid analysis-cohort change.')
  }
  return {
    cause: oneOf(
      value.cause,
      ANALYSIS_COHORT_CHANGE_CAUSES,
      'analysis-cohort change cause',
    ),
    ...('reasons' in value
      ? { reasons: parseAnalysisCohortReasons(value.reasons) }
      : {}),
  }
}

function parseStageCurrency(
  value: unknown,
): NonNullable<ResultPage['stageCurrency']> {
  if (!isRecord(value) || Object.keys(value).length > STEP_KEYS.length) {
    throw new TypeError('Provide valid stage receipt currency.')
  }
  const parsed: NonNullable<ResultPage['stageCurrency']> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      throw new TypeError('Provide valid stage receipt currency.')
    }
    parsed[stepKey(key)] = {
      state: oneOf(entry.state, STAGE_CURRENCY_STATES, 'stage currency state'),
      outdatedSubjectIds: subjectIds(
        entry.outdatedSubjectIds,
        'out-of-date subject list',
      ),
      ...('cause' in entry
        ? {
            cause: oneOf(
              entry.cause,
              STAGE_CURRENCY_CAUSES,
              'stage currency cause',
            ),
          }
        : {}),
    }
  }
  return parsed
}

/**
 * Report which list row failed its contract, when the parser recorded one.
 *
 * @returns The zero-based row index, or null when none was recorded.
 */
export function contractRowIndex(error: unknown): number | null {
  if (!(error instanceof Error)) return null
  const index = (error as { rowIndex?: unknown }).rowIndex
  return typeof index === 'number' && Number.isInteger(index) && index >= 0
    ? index
    : null
}

/**
 * Parse every row of a list result, recording which row failed its contract.
 *
 * Record the index on the thrown error rather than in its message, because the
 * message reaches the operator while the index only has to reach the log.
 *
 * @throws {TypeError} For the first row that fails its contract.
 */
function parseRows<T>(
  rows: readonly unknown[],
  parseRow: (row: unknown) => T,
): T[] {
  return rows.map((row, index) => {
    try {
      return parseRow(row)
    } catch (error) {
      if (error instanceof Error && contractRowIndex(error) === null) {
        Object.defineProperty(error, 'rowIndex', {
          value: index,
          enumerable: false,
          configurable: true,
        })
      }
      throw error
    }
  })
}

function parseRegistryRecord(value: unknown): RegistryRecord {
  if (
    !isRecord(value) ||
    !Array.isArray(value.qcTags) ||
    value.qcTags.length > 64
  ) {
    throw new TypeError('Provide a valid registry record.')
  }
  const parsed: RegistryRecord = {
    subjectId: identifier(value.subjectId, 'registry subject ID'),
    age: value.age === null ? null : finiteNumber(value.age, 'registry age'),
    sex: oneOf(value.sex, new Set(['M', 'F', 'O'] as const), 'registry sex'),
    sourceCohortLabel: boundedString(
      value.sourceCohortLabel,
      'registry source cohort',
      512,
    ),
    cohortRole: oneOf(
      value.cohortRole,
      new Set([
        'healthy',
        'sci-no-neuropathic-pain',
        'sci-neuropathic-pain',
        'ambiguous',
      ] as const),
      'registry cohort role',
    ),
    ais:
      value.ais === null
        ? null
        : oneOf(value.ais, new Set(['A', 'B', 'C', 'D'] as const), 'AIS grade'),
    tSinceSci:
      value.tSinceSci === null
        ? null
        : finiteNumber(value.tSinceSci, 'time since injury'),
    t1Availability: oneOf(
      value.t1Availability,
      new Set(['available', 'missing', 'ambiguous'] as const),
      'T1 availability',
    ),
    runnable: booleanValue(value.runnable, 'registry runnable state'),
    unavailableReason: nullableString(
      value.unavailableReason,
      'registry unavailable reason',
      8_192,
    ),
    qc:
      value.qc === null
        ? null
        : oneOf(
            value.qc,
            new Set(['pass', 'fail', 'defer'] as const),
            'QC verdict',
          ),
    qcNote: boundedString(value.qcNote, 'registry QC note', 8_192, true),
    qcTags: value.qcTags.map((entry) =>
      boundedString(entry, 'registry QC tag', 512),
    ),
    revision: nonNegativeInteger(value.revision, 'registry revision'),
    updatedAt: boundedString(value.updatedAt, 'registry update time', 256),
    // A record without a site has no key.
    site:
      value.site === undefined || value.site === null
        ? null
        : siteLabel(value.site, 'registry site'),
  }
  if ('recordedQcVerdict' in value) {
    parsed.recordedQcVerdict =
      value.recordedQcVerdict === null
        ? null
        : oneOf(
            value.recordedQcVerdict,
            new Set(['pass', 'fail', 'defer'] as const),
            'recorded QC verdict',
          )
  }
  if ('qcReviewEvidencePresent' in value) {
    parsed.qcReviewEvidencePresent = booleanValue(
      value.qcReviewEvidencePresent,
      'QC review evidence state',
    )
  }
  return parsed
}

const MAX_IMPORT_ISSUES = 500

function parseRegistrySetSiteResult(value: unknown): RegistrySetSiteResult {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid site result.')
  }
  const updated = nonNegativeInteger(value.updated, 'site update count')
  if (updated > MAX_SET_SITE_SUBJECTS) {
    throw new TypeError('Provide a bounded site update count.')
  }
  return {
    site: value.site === null ? null : siteLabel(value.site, 'site result'),
    updated,
  }
}

function parseRegistryImportIssue(value: unknown): RegistryImportIssue {
  if (!isRecord(value)) {
    throw new TypeError('Provide a valid registry import issue.')
  }
  const row =
    value.row === null
      ? null
      : nonNegativeInteger(value.row, 'registry import row')
  if (row !== null && row < 1) {
    throw new TypeError('Provide a 1-based registry import row.')
  }
  return {
    row,
    message: boundedString(value.message, 'registry import message', 2_048),
  }
}

function parseRegistryImportResult(value: unknown): RegistryImportResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.errors) ||
    !Array.isArray(value.warnings) ||
    value.errors.length > MAX_IMPORT_ISSUES ||
    value.warnings.length > MAX_IMPORT_ISSUES
  ) {
    throw new TypeError('Provide a valid registry import result.')
  }
  return {
    applied: booleanValue(value.applied, 'registry import applied state'),
    imported: nonNegativeInteger(value.imported, 'registry imported count'),
    updated: nonNegativeInteger(value.updated, 'registry updated count'),
    skipped: nonNegativeInteger(value.skipped, 'registry skipped count'),
    errors: value.errors.map(parseRegistryImportIssue),
    warnings: value.warnings.map(parseRegistryImportIssue),
    errorTotal: nonNegativeInteger(value.errorTotal, 'registry error total'),
    warningTotal: nonNegativeInteger(
      value.warningTotal,
      'registry warning total',
    ),
  }
}

/** Validate and project one result before it crosses into renderer code. */
export function parseSidecarRpcResult(method: string, value: unknown): unknown {
  const bounded = boundedJson(value)
  switch (method) {
    case 'env.check':
      return parseEnvironmentReport(bounded)
    case 'env.optInInstall':
      return parseOperationResult(bounded)
    case 'env.installStatus':
      return parseEnvInstallStatus(bounded)
    case 'env.createOutputDir':
      return parseEnvCreateDirResult(bounded)
    case 'env.toolStatus':
      return parseToolStatus(bounded)
    case 'provision.pybrainage':
    case 'provision.braincharts':
    case 'provision.synthstrip':
    case 'provision.fastsurfer':
    case 'managedResource.importOffline':
      return parseOperationResult(bounded)
    case 'provision.status':
      return parseProvisionStatus(bounded)
    case 'provision.cancel':
    case 'managedResource.cancel':
      return parseCancelResult(bounded)
    case 'pipeline.listSteps':
      return parseStepDescriptors(bounded)
    case 'pipeline.previewCommand':
      return boundedString(bounded, 'command preview', 65_536, true)
    case 'pipeline.planWorkflow':
    case 'pipeline.runWorkflow':
    case 'pipeline.resumeWorkflow':
    case 'pipeline.retryWorkflow':
      return parseWorkflowResult(bounded)
    case 'pipeline.cancelRun':
      return parseCancelRun(bounded)
    case 'runtime.bootstrap':
      return parseRuntimeSnapshot(bounded)
    case 'manifest.forRun':
      return parseManifest(bounded)
    case 'manifest.list':
      return parseManifestPage(bounded)
    case 'manifest.previewDebug':
      return parseDebugPreview(bounded)
    case 'manifest.bundleDebug': {
      if (!isRecord(bounded)) {
        throw new TypeError('Provide a valid debug-bundle result.')
      }
      return {
        artifactId: identifier(bounded.artifactId, 'debug artifact ID'),
        displayPath: boundedString(
          bounded.displayPath,
          'debug display path',
          MAX_PATH_CHARACTERS,
        ),
      }
    }
    case 'results.list':
      return parseResultPage(bounded)
    case 'surfaceRegistration.status':
      return parseSurfaceRegistrationStatus(bounded)
    case 'surfaceRegistration.check':
      return parseSurfaceRegistrationCheckResult(bounded)
    case 'surfaceRegistration.cancel':
      return parseSurfaceRegistrationCancelResult(bounded)
    case 'groupAnalysis.catalog':
      return parseGroupAnalysisCatalog(bounded)
    case 'groupAnalysis.inputs':
      return parseGroupAnalysisInputs(bounded)
    case 'groupAnalysis.start':
      return parseGroupAnalysisStartResult(bounded)
    case 'groupAnalysis.status':
      return parseGroupAnalysisStatus(bounded)
    case 'groupAnalysis.cancel':
      return parseGroupAnalysisCancelResult(bounded)
    case 'groupAnalysis.list':
      return parseGroupAnalysisList(bounded)
    case 'groupAnalysis.result':
      return parseGroupAnalysisResult(bounded)
    case 'groupAnalysis.measureDetail':
      return parseGroupAnalysisMeasureDetail(bounded)
    case 'groupAnalysis.saveSpec':
    case 'groupAnalysis.deleteSpec':
    case 'groupAnalysis.saveSet':
    case 'groupAnalysis.lockSet':
    case 'groupAnalysis.deleteSet':
      return parseGroupAnalysisLibrary(bounded)
    case 'groupAnalysis.termRows':
      return parseGroupAnalysisTermRows(bounded)
    case 'groupAnalysis.atlases':
      return parseAtlasCatalog(bounded)
    case 'groupAnalysis.labelStart':
      return parseAtlasLabelStartResult(bounded)
    case 'groupAnalysis.labelStatus':
      return parseAtlasLabelStatus(bounded)
    case 'groupAnalysis.labelCancel':
      return parseAtlasLabelCancelResult(bounded)
    case 'groupAnalysis.clearLabels':
      return parseAtlasLabelsCleared(bounded)
    case 'registry.list':
      if (!Array.isArray(bounded) || bounded.length > MAX_ROWS) {
        throw new TypeError('Provide a bounded registry list.')
      }
      return parseRows(bounded, parseRegistryRecord)
    case 'registry.upsert':
      return parseRegistryRecord(bounded)
    case 'registry.importCsv':
      return parseRegistryImportResult(bounded)
    case 'registry.remove':
      if (bounded !== null)
        throw new TypeError('Return null after registry removal.')
      return null
    case 'registry.setSite':
      return parseRegistrySetSiteResult(bounded)
    default:
      // Input-FOV, managed-resource status, and Subject results receive their
      // stronger method-specific parsers in main and preload. The bounded JSON
      // pass here still prevents an unbounded or nonfinite intermediate value.
      return bounded
  }
}
