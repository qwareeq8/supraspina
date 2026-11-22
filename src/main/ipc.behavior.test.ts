import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version as APP_VERSION } from '../../package.json'
import {
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
  validateProjectConfig,
} from '../shared/project-schema'
import type {
  ProjectOpenResult,
  QcReviewOpenGrant,
  ResultArtifact,
} from '../shared/contract'
import { REGISTRY_IMPORT_EXAMPLE_CSV } from '../shared/registry-import'
import { MATRIX_STEP_COUNT } from '../shared/steps'
import { emptyCell } from '../shared/types'

const shell = {
  showItemInFolder: vi.fn(),
  openPath: vi.fn(async () => ''),
  openExternal: vi.fn(async () => undefined),
}
const dialog = {
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
  },
  dialog,
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell,
}))

interface HandlerContext {
  senderId: number
}

type Handler = (args: unknown[], context?: HandlerContext) => Promise<unknown>

function configFor(root: string): ProjectConfig {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  cfg.project.name = 'Test project'
  cfg.project.createdAt = '2026-07-22T00:00:00.000Z'
  cfg.paths.projectRoot = root
  return cfg
}

function exportRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'participant-X9',
    cohort: 'SCI_P',
    age: 35,
    sex: 'F',
    ais: null,
    tSinceSci: null,
    cells: Array.from({ length: MATRIX_STEP_COUNT }, () => emptyCell()),
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
    ...overrides,
  }
}

function fabricatedQcReviewEvidence(): unknown {
  const openedAt = '2026-07-31T12:00:00.000Z'
  const runId = 'run-12345678'
  const receiptSha256 = '1'.repeat(64)
  return {
    galleries: [
      ['subcortical', 'Subcortical QC gallery'],
      ['internal', 'Cortical-internal QC gallery'],
      ['external', 'Cortical-external QC gallery'],
    ].map(([tab, label]) => ({
      tab: tab as 'subcortical' | 'internal' | 'external',
      label: label!,
      displayPath: `/tmp/${tab}.html`,
      runId,
      receiptSha256,
      openedAt,
    })),
  }
}

interface FakeResolvedArtifact {
  path: string
  kind: 'file' | 'directory'
  metadata?: Pick<
    ResultArtifact,
    | 'artifactId'
    | 'label'
    | 'stepKey'
    | 'subjectId'
    | 'kind'
    | 'presence'
    | 'displayPath'
    | 'runId'
    | 'producerNodeId'
    | 'receiptSha256'
    | 'provenance'
  > & {
    inventoryRunId: string
    configSha256: string
  }
}

function canonicalConfigDigest(cfg: ProjectConfig): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      )
    }
    return value
  }
  return createHash('sha256')
    .update(JSON.stringify(normalize(cfg)))
    .digest('hex')
}

function makeSidecar() {
  const artifactPaths = new Map<string, FakeResolvedArtifact>()
  const qcGalleryPanels = new Map<string, unknown>()
  const manifestRunIds: string[] = []
  const manifestSteps = new Map<string, { key: string }[]>()
  const manifestExtras = new Map<string, Record<string, unknown>>()
  const qcPages = new Map<
    string,
    {
      items: ResultArtifact[]
      nextCursor: null
      truncated: false
      runId: string
      configSha256: string
    }
  >()
  const runtimeJobs: Array<Record<string, unknown>> = []
  /** The run of each `results.list` call answered with a full inventory. */
  const fullInventories: Array<string | null> = []
  const state = {
    state: 'ready' as const,
    generation: 1,
    productVersion: APP_VERSION,
    protocolVersion: '1',
    persistenceVersions: { project: 1, runState: 1, manifest: 1, receipt: 1 },
    capabilities: [],
    runtimeId: 'runtime',
    projectAttached: true,
    retryable: false,
    detail: null,
  }
  return {
    artifactPaths,
    qcGalleryPanels,
    manifestRunIds,
    manifestSteps,
    manifestExtras,
    qcPages,
    fullInventories,
    call: vi.fn(async (method: string, args: unknown[]): Promise<unknown> => {
      if (method === 'system.detachProject') {
        state.projectAttached = false
        return { detached: true, projectAttached: false }
      }
      if (method === 'results.resolveArtifact') {
        const request = args[0] as { artifactId: string }
        const artifact = artifactPaths.get(request.artifactId)
        return artifact
          ? { ...artifact, exists: true }
          : { path: '', kind: 'file', exists: false }
      }
      if (method === 'results.list') {
        const request = args[0] as {
          runId?: string
          currentConfigSha256?: string
          galleryPresence?: boolean
        }
        const runId = request.runId ?? [...qcPages.keys()][0] ?? null
        const page =
          runId && qcPages.has(runId)
            ? qcPages.get(runId)!
            : { items: [], nextCursor: null, truncated: false, runId }
        // Mirror the sidecar's digest-only answer for another configuration,
        // with the rows' presence alone when asked for it.
        if (
          request.currentConfigSha256 !== undefined &&
          'configSha256' in page &&
          page.configSha256 !== request.currentConfigSha256
        ) {
          return {
            ...page,
            items: [],
            total: 0,
            ...(request.galleryPresence === true
              ? {
                  galleryPresence: page.items.map((item) => ({
                    label: item.label,
                    stepKey: item.stepKey,
                    subjectId: item.subjectId,
                    kind: item.kind,
                    presence: item.presence,
                    exists: item.exists,
                  })),
                }
              : {}),
          }
        }
        fullInventories.push(runId)
        return page
      }
      if (method === 'results.qcGalleryImages') {
        const request = args[0] as {
          runId: string
          tab: string
          subjectId: string
        }
        const described = qcGalleryPanels.get(
          `${request.runId}\u0000${request.tab}\u0000${request.subjectId}`,
        )
        if (!described)
          throw new Error('Describe the montage before requesting it.')
        return described
      }
      if (method === 'manifest.list') {
        const runIds =
          manifestRunIds.length > 0 ? manifestRunIds : [...qcPages.keys()]
        return {
          items: runIds.map((runId) => {
            const steps = manifestSteps.get(runId)
            return {
              ...manifestExtras.get(runId),
              ...(steps ? { runId, steps } : { runId }),
            }
          }),
          nextCursor: null,
        }
      }
      if (method === 'runtime.bootstrap') {
        return {
          project: (args[0] as { project: unknown }).project,
          sidecarGeneration: 1,
          sequence: 1,
          runs: [],
          jobs: runtimeJobs,
          logTail: [],
          provision: null,
        }
      }
      return null
    }),
    runtimeJobs,
    getState: vi.fn(() => state),
    retry: vi.fn(async () => undefined),
    setProjectAttached: vi.fn((attached: boolean) => {
      state.projectAttached = attached
    }),
  }
}

async function freshHandlers(
  sidecar = makeSidecar(),
  services: {
    artifactUseBarrier?: (path: string) => Promise<void>
    userDataPath?: string
  } = {},
) {
  vi.resetModules()
  const { nativeHandlers } = await import('./ipc')
  return {
    handlers: nativeHandlers({
      sidecar: sidecar as never,
      ...services,
    }) as Record<string, Handler>,
    sidecar,
  }
}

async function createProject(
  handlers: Record<string, Handler>,
  path: string,
  epoch = 1,
): Promise<ProjectOpenResult> {
  return handlers['project.create']!([
    { at: path, cfg: configFor(path), epoch },
  ]) as Promise<ProjectOpenResult>
}

async function issueQcReviewGrants(
  handlers: Record<string, Handler>,
  sidecar: ReturnType<typeof makeSidecar>,
  opened: ProjectOpenResult,
  options: {
    subjectId?: string
    ownerId?: number
    inventoryRunId?: string
    runId?: string
    receiptSha256?: string
    configSha256?: string
  } = {},
): Promise<{ grantIds: string[]; items: ResultArtifact[] }> {
  const subjectId = options.subjectId ?? 'participant-X9'
  const ownerId = options.ownerId ?? 7
  const inventoryRunId = options.inventoryRunId ?? 'run-12345678'
  const runId = options.runId ?? inventoryRunId
  const receiptSha256 = options.receiptSha256 ?? '1'.repeat(64)
  const configSha256 = options.configSha256 ?? canonicalConfigDigest(opened.cfg)
  const directory = join(
    opened.project.root,
    'derivatives',
    'qc-grants',
    subjectId,
    inventoryRunId,
  )
  await mkdir(directory, { recursive: true })
  const specifications = [
    ['subcortical', 'Subcortical QC gallery'],
    ['internal', 'Cortical-internal QC gallery'],
    ['external', 'Cortical-external QC gallery'],
  ] as const
  const items: ResultArtifact[] = []
  for (const [tab, label] of specifications) {
    const artifactId = `artifact-${subjectId}-${inventoryRunId}-${tab}`
    const path = join(directory, `${tab}.html`)
    await writeFile(path, `<html><body>${subjectId}</body></html>`)
    const item: ResultArtifact = {
      artifactId,
      label,
      stepKey: 'enigma',
      subjectId: null,
      kind: 'html',
      presence: 'produced',
      displayPath: path,
      exists: true,
      openable: true,
      revealable: true,
      runId,
      producerNodeId: 'enigma:cohort',
      receiptSha256,
      provenance: 'current',
    }
    items.push(item)
    sidecar.artifactPaths.set(artifactId, {
      path,
      kind: 'file',
      metadata: {
        artifactId: item.artifactId,
        label: item.label,
        stepKey: item.stepKey,
        subjectId: item.subjectId,
        kind: item.kind,
        presence: item.presence,
        displayPath: item.displayPath,
        runId: item.runId,
        producerNodeId: item.producerNodeId,
        receiptSha256: item.receiptSha256,
        provenance: item.provenance,
        inventoryRunId,
        configSha256,
      },
    })
  }
  sidecar.qcPages.set(inventoryRunId, {
    items,
    nextCursor: null,
    truncated: false,
    runId: inventoryRunId,
    configSha256,
  })
  const grants: QcReviewOpenGrant[] = []
  for (const item of items) {
    const result = (await handlers['artifact.open']!(
      [
        {
          project: opened.project,
          artifactId: item.artifactId,
          focusText: subjectId,
        },
      ],
      { senderId: ownerId },
    )) as { reviewGrant: QcReviewOpenGrant | null }
    if (!result.reviewGrant) throw new Error('Issue the QC review grant.')
    grants.push(result.reviewGrant)
  }
  return { grantIds: grants.map((grant) => grant.grantId), items }
}

async function installSharedQcGalleries(
  sidecar: ReturnType<typeof makeSidecar>,
  opened: ProjectOpenResult,
  galleryText: string,
): Promise<ResultArtifact[]> {
  const inventoryRunId = 'run-12345678'
  const receiptSha256 = '1'.repeat(64)
  const directory = join(
    opened.project.root,
    'derivatives',
    'shared-qc-grants',
    inventoryRunId,
  )
  await mkdir(directory, { recursive: true })
  const specifications = [
    ['subcortical', 'Subcortical QC gallery'],
    ['internal', 'Cortical-internal QC gallery'],
    ['external', 'Cortical-external QC gallery'],
  ] as const
  const items: ResultArtifact[] = []
  for (const [tab, label] of specifications) {
    const artifactId = `artifact-shared-${inventoryRunId}-${tab}`
    const path = join(directory, `${tab}.html`)
    await writeFile(path, galleryText)
    const item: ResultArtifact = {
      artifactId,
      label,
      stepKey: 'enigma',
      subjectId: null,
      kind: 'html',
      presence: 'produced',
      displayPath: path,
      exists: true,
      openable: true,
      revealable: true,
      runId: inventoryRunId,
      producerNodeId: 'enigma:cohort',
      receiptSha256,
      provenance: 'current',
    }
    items.push(item)
    sidecar.artifactPaths.set(artifactId, {
      path,
      kind: 'file',
      metadata: {
        artifactId,
        label,
        stepKey: 'enigma',
        subjectId: null,
        kind: 'html',
        presence: 'produced',
        displayPath: path,
        runId: inventoryRunId,
        producerNodeId: 'enigma:cohort',
        receiptSha256,
        provenance: 'current',
        inventoryRunId,
        configSha256: canonicalConfigDigest(opened.cfg),
      },
    })
  }
  sidecar.qcPages.set(inventoryRunId, {
    items,
    nextCursor: null,
    truncated: false,
    runId: inventoryRunId,
    configSha256: canonicalConfigDigest(opened.cfg),
  })
  return items
}

async function issueSharedQcReviewGrants(
  handlers: Record<string, Handler>,
  sidecar: ReturnType<typeof makeSidecar>,
  opened: ProjectOpenResult,
  subjectIds: string[],
  ownerId = 7,
): Promise<Map<string, string[]>> {
  const items = await installSharedQcGalleries(
    sidecar,
    opened,
    `<html><body>${subjectIds.join(' ')}</body></html>`,
  )
  const grantsBySubject = new Map<string, string[]>()
  for (const subjectId of subjectIds) {
    const grants: string[] = []
    for (const item of items) {
      const result = (await handlers['artifact.open']!(
        [
          {
            project: opened.project,
            artifactId: item.artifactId,
            focusText: subjectId,
          },
        ],
        { senderId: ownerId },
      )) as { reviewGrant: QcReviewOpenGrant | null }
      if (!result.reviewGrant) throw new Error('Issue the QC review grant.')
      grants.push(result.reviewGrant.grantId)
    }
    grantsBySubject.set(subjectId, grants)
  }
  return grantsBySubject
}

/**
 * Install one run's complete cohort-level ENIGMA gallery set in the stub.
 *
 * Register each gallery with the artifact resolver as a current
 * detector-issued artifact of that inventory, and serve the inventory page
 * with the requested provenance and configuration digest.
 */
async function installQcGalleryRun(
  sidecar: ReturnType<typeof makeSidecar>,
  opened: ProjectOpenResult,
  inventoryRunId: string,
  options: {
    provenance?: ResultArtifact['provenance']
    configSha256?: string
    receiptSha256?: string
    truncated?: boolean
  } = {},
): Promise<ResultArtifact[]> {
  const configSha256 = options.configSha256 ?? canonicalConfigDigest(opened.cfg)
  const receiptSha256 = options.receiptSha256 ?? '1'.repeat(64)
  const directory = join(opened.project.root, 'derivatives', inventoryRunId)
  await mkdir(directory, { recursive: true })
  const items: ResultArtifact[] = []
  for (const [tab, label] of [
    ['subcortical', 'Subcortical QC gallery'],
    ['internal', 'Cortical-internal QC gallery'],
    ['external', 'Cortical-external QC gallery'],
  ] as const) {
    const artifactId = `artifact-${inventoryRunId}-${tab}`
    const path = join(directory, `${tab}.html`)
    await writeFile(path, '<html><body>sub-001</body></html>')
    const item: ResultArtifact = {
      artifactId,
      label,
      stepKey: 'enigma',
      subjectId: null,
      kind: 'html',
      presence: 'produced',
      displayPath: path,
      exists: true,
      openable: true,
      revealable: true,
      runId: inventoryRunId,
      producerNodeId: 'enigma:cohort',
      receiptSha256,
      provenance: options.provenance ?? 'current',
    }
    items.push(item)
    sidecar.artifactPaths.set(artifactId, {
      path,
      kind: 'file',
      metadata: {
        artifactId,
        label,
        stepKey: 'enigma',
        subjectId: null,
        kind: 'html',
        presence: 'produced',
        displayPath: path,
        runId: inventoryRunId,
        producerNodeId: 'enigma:cohort',
        receiptSha256,
        provenance: 'current',
        inventoryRunId,
        configSha256,
      },
    })
  }
  sidecar.qcPages.set(inventoryRunId, {
    items,
    nextCursor: null,
    truncated: (options.truncated ?? false) as false,
    runId: inventoryRunId,
    configSha256,
  })
  return items
}

/** Count the sidecar calls one QC authority sweep makes. */
function qcSweepCalls(sidecar: ReturnType<typeof makeSidecar>): {
  manifests: number
  inventories: number
} {
  const methods = sidecar.call.mock.calls.map(([method]) => method)
  return {
    manifests: methods.filter((method) => method === 'manifest.list').length,
    inventories: methods.filter((method) => method === 'results.list').length,
  }
}

async function installQcFixture(
  projectRoot: string,
  name: string,
): Promise<string> {
  const directory = join(projectRoot, '.supraspina')
  const target = join(directory, 'qc_verdicts.json')
  await mkdir(directory, { recursive: true })
  await copyFile(resolve(process.cwd(), 'fixtures', 'qc-store', name), target)
  return target
}

let root: string

beforeEach(async () => {
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'supraspina-main-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('project authority and persistence', () => {
  it('creates a structurally valid project atomically even when host tools are absent', async () => {
    const { handlers } = await freshHandlers()
    const projectRoot = join(root, 'project')
    const result = await createProject(handlers, projectRoot)
    expect(result.project).toMatchObject({ root: projectRoot, epoch: 1 })
    expect(result.configSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(join(projectRoot, 'supraspina.project.json'))).toBe(true)
    expect(result.cfg.tools.freesurferHome).toBe('')
  })

  it('reports absent QC authority instead of throwing on an undefined optional field', async () => {
    // Electron's structured clone keeps an own key holding undefined. The
    // canonical digest must ignore it exactly as the persisted JSON does,
    // otherwise every QC authority path dies with a raw TypeError.
    const { handlers } = await freshHandlers()
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const withUndefined = structuredClone(opened.cfg) as ProjectConfig & {
      provenance: Record<string, string | undefined>
    }
    withUndefined.provenance['gitSha'] = undefined

    await handlers['project.save']!([
      {
        project: opened.project,
        cfg: withUndefined,
        configRevision: 1,
        safeExecution: false,
        expectedSha256: opened.configSha256,
      },
    ])

    // A project without a current gallery set is an expected answer, not an
    // unexpected main-process exception.
    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual({
      runId: null,
      inventoryKey: null,
      unavailable: {
        reason: 'noCurrentGallery',
        message:
          'Run ENIGMA QC under the saved project configuration to review galleries.',
      },
    })
  })

  it('names galleries from an earlier configuration and their different cohort', async () => {
    // Galleries from a smaller earlier cohort must be named as such, not
    // reported as though QC had never run.
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const earlierRunId = 'run-11111111'
    sidecar.manifestRunIds.push('run-22222222', earlierRunId)
    sidecar.manifestSteps.set('run-22222222', [{ key: 'recon' }])
    sidecar.manifestExtras.set('run-22222222', {
      analysisCohort: {
        subjectIds: Array.from({ length: 82 }, (_, index) => `sub-${index}`),
        sha256: '4'.repeat(64),
      },
    })
    sidecar.manifestExtras.set(earlierRunId, {
      analysisCohort: {
        subjectIds: Array.from({ length: 48 }, (_, index) => `sub-${index}`),
        sha256: '3'.repeat(64),
      },
    })
    await installQcGalleryRun(sidecar, opened, earlierRunId, {
      configSha256: 'f'.repeat(64),
    })

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual({
      runId: null,
      inventoryKey: null,
      unavailable: {
        reason: 'earlierGallery',
        earlierRunId,
        message:
          'The newest ENIGMA QC galleries were produced under an earlier project configuration. ' +
          'They cover 48 subjects, and the newest run analyzed 82 subjects. ' +
          'Run ENIGMA QC under the saved configuration to review galleries.',
      },
    })
  })

  it('leaves the cohort out when only the configuration changed', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const cohort = {
      analysisCohort: {
        subjectIds: ['sub-1', 'sub-2'],
        sha256: '3'.repeat(64),
      },
    }
    sidecar.manifestRunIds.push('run-22222222', 'run-11111111')
    sidecar.manifestSteps.set('run-22222222', [{ key: 'recon' }])
    sidecar.manifestExtras.set('run-22222222', cohort)
    sidecar.manifestExtras.set('run-11111111', cohort)
    await installQcGalleryRun(sidecar, opened, 'run-11111111', {
      configSha256: 'f'.repeat(64),
    })

    const answer = (await handlers['qc.authoritativeRun']!([
      { project: opened.project },
    ])) as { unavailable: { message: string } }
    expect(answer.unavailable.message).toBe(
      'The newest ENIGMA QC galleries were produced under an earlier project configuration. ' +
        'Run ENIGMA QC under the saved configuration to review galleries.',
    )
  })

  it('reads only the newest earlier-configuration gallery run beyond its digest', async () => {
    // A full inventory costs about two seconds per run, so without a current
    // gallery set only the newest earlier run may be read beyond its digest.
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const runIds = Array.from(
      { length: 20 },
      (_, index) => `run-${String(30 + index).padStart(8, '0')}`,
    ).reverse()
    sidecar.manifestRunIds.push(...runIds)
    for (const runId of runIds) {
      sidecar.manifestSteps.set(runId, [{ key: 'enigma' }])
      await installQcGalleryRun(sidecar, opened, runId, {
        configSha256: 'f'.repeat(64),
      })
    }

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toMatchObject({
      runId: null,
      unavailable: { reason: 'earlierGallery', earlierRunId: runIds[0] },
    })
    const requests = sidecar.call.mock.calls
      .filter(([method]) => method === 'results.list')
      .map(([, args]) => (args as [Record<string, unknown>])[0])
    // The newest run answers with its gallery presence, every older one with
    // its digest alone, and none is inventoried in full.
    expect(requests.filter((r) => r.galleryPresence === true)).toEqual([
      expect.objectContaining({ runId: runIds[0] }),
    ])
    expect(sidecar.fullInventories).toEqual([])
    expect(requests).toHaveLength(runIds.length)
  })

  it('reports no current gallery without a full inventory of any run', async () => {
    // When no ENIGMA run matches the configuration and none holds galleries,
    // the search must say so without a full inventory of any run.
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const runIds = Array.from(
      { length: 20 },
      (_, index) => `run-${String(30 + index).padStart(8, '0')}`,
    ).reverse()
    sidecar.manifestRunIds.push(...runIds)
    for (const runId of runIds) {
      sidecar.manifestSteps.set(runId, [{ key: 'enigma' }])
      sidecar.qcPages.set(runId, {
        items: [],
        nextCursor: null,
        truncated: false,
        runId,
        configSha256: 'f'.repeat(64),
      })
    }

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual({
      runId: null,
      inventoryKey: null,
      unavailable: {
        reason: 'noCurrentGallery',
        message:
          'Run ENIGMA QC under the saved project configuration to review galleries.',
      },
    })
    const requests = sidecar.call.mock.calls
      .filter(([method]) => method === 'results.list')
      .map(([, args]) => (args as [Record<string, unknown>])[0])
    expect(sidecar.fullInventories).toEqual([])
    expect(requests.map((r) => r.runId)).toEqual(runIds)
    expect(requests.every((r) => r.galleryPresence === true)).toBe(true)
  })

  it('inventories a run in full when its answer lacks gallery presence', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    sidecar.manifestSteps.set('run-11111111', [{ key: 'enigma' }])
    await installQcGalleryRun(sidecar, opened, 'run-11111111', {
      configSha256: 'f'.repeat(64),
    })
    const runtime = sidecar.call.getMockImplementation()!
    sidecar.call.mockImplementation(async (method: string, args: unknown[]) => {
      const answer = await runtime(method, args)
      if (method !== 'results.list') return answer
      const digestOnly = { ...(answer as Record<string, unknown>) }
      delete digestOnly.galleryPresence
      return digestOnly
    })

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toMatchObject({
      runId: null,
      unavailable: { reason: 'earlierGallery', earlierRunId: 'run-11111111' },
    })
    expect(sidecar.fullInventories).toEqual(['run-11111111'])
  })

  it('still finds an older current gallery set behind an earlier configuration', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-33333333', 'run-22222222', 'run-11111111')
    for (const runId of sidecar.manifestRunIds) {
      sidecar.manifestSteps.set(runId, [{ key: 'enigma' }])
    }
    await installQcGalleryRun(sidecar, opened, 'run-33333333', {
      configSha256: 'f'.repeat(64),
    })
    await installQcGalleryRun(sidecar, opened, 'run-22222222', {
      configSha256: 'e'.repeat(64),
    })
    await installQcGalleryRun(sidecar, opened, 'run-11111111')

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toMatchObject({ runId: 'run-11111111', unavailable: null })
  })

  it.each([
    ['throws', () => Promise.reject(new Error('The sidecar stopped.'))],
    [
      'returns no digest',
      () => Promise.resolve({ items: [], nextCursor: null, truncated: false }),
    ],
  ])(
    'inventories a run in full when its digest probe %s',
    async (_name, probe) => {
      const { handlers, sidecar } = await freshHandlers()
      const opened = await createProject(handlers, join(root, 'project'))
      sidecar.manifestRunIds.push('run-22222222', 'run-11111111')
      for (const runId of sidecar.manifestRunIds) {
        sidecar.manifestSteps.set(runId, [{ key: 'enigma' }])
      }
      await installQcGalleryRun(sidecar, opened, 'run-22222222', {
        configSha256: 'f'.repeat(64),
      })
      await installQcGalleryRun(sidecar, opened, 'run-11111111')
      const runtime = sidecar.call.getMockImplementation()!
      sidecar.call.mockImplementation(
        async (method: string, args: unknown[]) => {
          const request = args[0] as Record<string, unknown>
          if (
            method === 'results.list' &&
            'currentConfigSha256' in request &&
            !('galleryPresence' in request)
          ) {
            return probe()
          }
          return runtime(method, args)
        },
      )

      await expect(
        handlers['qc.authoritativeRun']!([{ project: opened.project }]),
      ).resolves.toMatchObject({ runId: 'run-11111111', unavailable: null })
      const inventoried = sidecar.call.mock.calls
        .filter(([method]) => method === 'results.list')
        .map(([, args]) => (args as [Record<string, unknown>])[0])
        .filter((request) => request.galleryPresence === true)
        .map((request) => request.runId)
      expect(inventoried).toEqual(['run-22222222', 'run-11111111'])
      expect(sidecar.fullInventories).toEqual(['run-11111111'])
    },
  )

  it('digests a configuration as the sidecar inventory does', async () => {
    // The sidecar suite asserts the same digest for its inventory of this
    // configuration, so a drift on either side fails both.
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), 'fixtures', 'config-digest', 'project.json'),
        'utf8',
      ),
    ) as { config: unknown; sha256: string }
    const parsed = validateProjectConfig(fixture.config)
    expect(parsed.ok).toBe(true)
    const { canonicalConfigSha256 } = await import('./ipc')
    expect(canonicalConfigSha256(parsed.data!)).toBe(fixture.sha256)
  })

  it('names stale galleries as out of date, not as an earlier cohort or configuration', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    sidecar.manifestSteps.set('run-11111111', [{ key: 'enigma' }])
    await installQcGalleryRun(sidecar, opened, 'run-11111111', {
      provenance: 'stale',
    })

    const answer = (await handlers['qc.authoritativeRun']!([
      { project: opened.project },
    ])) as { runId: string | null; unavailable: Record<string, string> }
    expect(answer).toEqual({
      runId: null,
      inventoryKey: null,
      unavailable: {
        reason: 'earlierGallery',
        earlierRunId: 'run-11111111',
        message:
          'The newest ENIGMA QC galleries are out of date because an ENIGMA QC input changed after they were produced. ' +
          'Rerun ENIGMA QC to review galleries.',
      },
    })
    expect(answer.unavailable.message).not.toMatch(/cohort|configuration/)
  })

  it('names galleries the verifier could not verify with its reason', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-22222222', 'run-11111111')
    sidecar.manifestSteps.set('run-22222222', [{ key: 'enigma' }])
    await installQcGalleryRun(sidecar, opened, 'run-11111111', {
      configSha256: 'f'.repeat(64),
    })
    const runtime = sidecar.call.getMockImplementation()!
    sidecar.call.mockImplementation(async (method: string, args: unknown[]) => {
      const request = args[0] as { runId?: string }
      if (method === 'results.list' && request.runId === 'run-22222222') {
        throw new Error('Repair the corrupt run store (ValueError).')
      }
      return runtime(method, args)
    })

    // The newest ENIGMA run is the one that failed to verify; the older run
    // from an earlier configuration must not be blamed instead.
    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual({
      runId: null,
      inventoryKey: null,
      unavailable: {
        reason: 'noCurrentGallery',
        message:
          'Supraspina could not verify the newest ENIGMA QC galleries. ' +
          'Repair the corrupt run store (ValueError). ' +
          'Reopen QC review to retry, or rerun ENIGMA QC if the problem persists.',
      },
    })
  })

  it('names an incomplete gallery inventory as unverifiable', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    await installQcGalleryRun(sidecar, opened, 'run-11111111', {
      truncated: true,
    })

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual({
      runId: null,
      inventoryKey: null,
      unavailable: {
        reason: 'earlierGallery',
        earlierRunId: 'run-11111111',
        message:
          'Supraspina could not verify the newest ENIGMA QC galleries. ' +
          'Their inventory is incomplete. ' +
          'Reopen QC review to retry, or rerun ENIGMA QC if the problem persists.',
      },
    })
  })

  it('answers a repeat visit from the cached authority without inventories', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    await installQcGalleryRun(sidecar, opened, 'run-11111111')

    const first = await handlers['qc.authoritativeRun']!([
      { project: opened.project },
    ])
    const afterFirst = qcSweepCalls(sidecar)
    expect(afterFirst.inventories).toBe(1)

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual(first)
    expect(qcSweepCalls(sidecar)).toEqual(afterFirst)
  })

  it('answers a repeat visit from a cached missing authority without inventories', async () => {
    // A missing authority is cached too, so a repeat visit does not inventory
    // every run again.
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-22222222', 'run-11111111')
    await installQcGalleryRun(sidecar, opened, 'run-22222222', {
      provenance: 'stale',
    })
    await installQcGalleryRun(sidecar, opened, 'run-11111111', {
      configSha256: 'f'.repeat(64),
    })

    const first = (await handlers['qc.authoritativeRun']!([
      { project: opened.project },
    ])) as { runId: string | null }
    expect(first.runId).toBeNull()
    const afterFirst = qcSweepCalls(sidecar)
    expect(afterFirst.inventories).toBe(2)

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual(first)
    expect(qcSweepCalls(sidecar)).toEqual(afterFirst)
  })

  it('searches again after a config save', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    await installQcGalleryRun(sidecar, opened, 'run-11111111')
    await handlers['qc.authoritativeRun']!([{ project: opened.project }])
    const beforeSave = qcSweepCalls(sidecar)

    await handlers['project.save']!([
      {
        project: opened.project,
        cfg: opened.cfg,
        configRevision: 1,
        safeExecution: false,
        expectedSha256: opened.configSha256,
      },
    ])
    await handlers['qc.authoritativeRun']!([{ project: opened.project }])

    const afterSave = qcSweepCalls(sidecar)
    expect(afterSave.manifests).toBeGreaterThan(beforeSave.manifests)
    expect(afterSave.inventories).toBe(beforeSave.inventories + 1)
  })

  it('searches again once the cached authority expires', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    await installQcGalleryRun(sidecar, opened, 'run-11111111')
    await handlers['qc.authoritativeRun']!([{ project: opened.project }])
    const beforeExpiry = qcSweepCalls(sidecar)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 6 * 60 * 1000)
      await handlers['qc.authoritativeRun']!([{ project: opened.project }])
    } finally {
      vi.useRealTimers()
    }
    expect(qcSweepCalls(sidecar).inventories).toBe(beforeExpiry.inventories + 1)
  })

  it('still rejects an invalid QC authority request and an unusable verifier', async () => {
    const { handlers } = await freshHandlers()
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)

    await expect(handlers['qc.authoritativeRun']!([null])).rejects.toThrow(
      /valid QC authority request/,
    )
    await expect(
      handlers['qc.authoritativeRun']!([{ project: { root: projectRoot } }]),
    ).rejects.toThrow()
    expect(opened.project.epoch).toBe(1)
  })

  it('rejects partial configs and project-root mismatches before persistence', async () => {
    const { handlers } = await freshHandlers()
    const target = join(root, 'project')
    await expect(
      handlers['project.create']!([
        { at: target, cfg: { paths: { projectRoot: target } }, epoch: 1 },
      ]),
    ).rejects.toThrow(/project.create/)
    await expect(
      handlers['project.create']!([
        { at: target, cfg: configFor(join(root, 'different')), epoch: 1 },
      ]),
    ).rejects.toThrow(/Match .* configured project root/)
    expect(existsSync(join(target, 'supraspina.project.json'))).toBe(false)
  })

  it('leaves no project file behind when the runtime refuses to detach', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    await createProject(handlers, join(root, 'project-a'))
    const runtime = sidecar.call.getMockImplementation()!
    let refuseDetach = true
    sidecar.call.mockImplementation(async (method: string, args: unknown[]) => {
      if (method === 'system.detachProject' && refuseDetach) {
        throw new Error('Stop the live work before detaching the project.')
      }
      return runtime(method, args)
    })
    const target = join(root, 'project-b')

    await expect(createProject(handlers, target, 2)).rejects.toThrow(
      /Stop the live work/,
    )
    // A published config would fail every retry on the existing-file guard.
    expect(existsSync(join(target, 'supraspina.project.json'))).toBe(false)

    refuseDetach = false
    const opened = await createProject(handlers, target, 3)
    expect(opened.project).toMatchObject({ root: target, epoch: 3 })
    expect(existsSync(join(target, 'supraspina.project.json'))).toBe(true)
    expect(
      sidecar.call.mock.calls.filter(
        ([method]) => method === 'system.detachProject',
      ),
    ).toHaveLength(2)
  })

  it('serializes concurrent compare-and-swap saves so only one writer wins', async () => {
    const { handlers } = await freshHandlers()
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const first = structuredClone(opened.cfg)
    first.project.name = 'First writer'
    const second = structuredClone(opened.cfg)
    second.project.name = 'Second writer'

    const results = await Promise.allSettled([
      handlers['project.save']!([
        {
          project: opened.project,
          cfg: first,
          configRevision: 1,
          safeExecution: false,
          expectedSha256: opened.configSha256,
        },
      ]),
      handlers['project.save']!([
        {
          project: opened.project,
          cfg: second,
          configRevision: 1,
          safeExecution: false,
          expectedSha256: opened.configSha256,
        },
      ]),
    ])
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1)
    const disk = JSON.parse(
      await readFile(join(projectRoot, 'supraspina.project.json'), 'utf8'),
    ) as ProjectConfig
    expect(['First writer', 'Second writer']).toContain(disk.project.name)
  })

  it('rejects save after an external disk change', async () => {
    const { handlers } = await freshHandlers()
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    await writeFile(join(projectRoot, 'supraspina.project.json'), '{}\n')
    await expect(
      handlers['project.save']!([
        {
          project: opened.project,
          cfg: opened.cfg,
          configRevision: 1,
          safeExecution: false,
          expectedSha256: opened.configSha256,
        },
      ]),
    ).rejects.toThrow(/changed on disk/)
  })

  it('rejects oversized project configurations across every trusted read', async () => {
    const { handlers } = await freshHandlers()
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const saved = (await handlers['project.save']!([
      {
        project: opened.project,
        cfg: opened.cfg,
        configRevision: 1,
        safeExecution: true,
        expectedSha256: opened.configSha256,
      },
    ])) as { sha256: string }
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)
    await writeFile(join(projectRoot, 'supraspina.project.json'), oversized)

    await expect(
      handlers['project.save']!([
        {
          project: opened.project,
          cfg: opened.cfg,
          configRevision: 2,
          safeExecution: true,
          expectedSha256: saved.sha256,
        },
      ]),
    ).rejects.toThrow(/bounded size limit/)
    await expect(
      handlers['execution.authorize']!(
        [
          {
            project: opened.project,
            configRevision: 1,
            purpose: 'live-workflow',
            planDigest: 'a'.repeat(64),
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/bounded size limit/)

    const otherRoot = join(root, 'other')
    await mkdir(otherRoot)
    await writeFile(join(otherRoot, 'supraspina.project.json'), oversized)
    await expect(
      handlers['project.open']!([{ path: otherRoot, epoch: 2 }]),
    ).rejects.toThrow(/bounded size limit/)
  })

  it('preserves project A after failed Open, then revokes A after successful B', async () => {
    const { handlers } = await freshHandlers()
    const aRoot = join(root, 'a')
    const a = await createProject(handlers, aRoot, 1)
    const brokenRoot = join(root, 'broken')
    await mkdir(brokenRoot)
    await writeFile(join(brokenRoot, 'supraspina.project.json'), '{bad json')
    await expect(
      handlers['project.open']!([{ path: brokenRoot, epoch: 2 }]),
    ).rejects.toThrow(/contains valid JSON/)
    await expect(
      handlers['subjects.markQc']!([
        {
          project: a.project,
          subjectId: 'participant-X9',
          verdict: null,
          note: '',
          tags: [],
        },
      ]),
    ).resolves.toMatchObject({ revision: 1 })

    const bRoot = join(root, 'b')
    await mkdir(bRoot)
    await writeFile(
      join(bRoot, 'supraspina.project.json'),
      `${JSON.stringify(configFor(bRoot), null, 2)}\n`,
    )
    const b = (await handlers['project.open']!([
      { path: bRoot, epoch: 3 },
    ])) as ProjectOpenResult
    expect(b.project.root).toBe(bRoot)
    await expect(
      handlers['subjects.markQc']!([
        {
          project: a.project,
          subjectId: 'participant-X9',
          verdict: 'fail',
          note: '',
          tags: [],
        },
      ]),
    ).rejects.toThrow(/stale or unknown/)
    await expect(
      handlers['project.save']!([
        {
          project: a.project,
          cfg: a.cfg,
          configRevision: 1,
          safeExecution: false,
          expectedSha256: a.configSha256,
        },
      ]),
    ).rejects.toThrow(/stale or unknown/)
  })

  it('accepts only a strictly newer project epoch and closes by exact identity', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const a = await createProject(handlers, join(root, 'a'), 4)
    const bRoot = join(root, 'b')
    await mkdir(bRoot)
    await writeFile(
      join(bRoot, 'supraspina.project.json'),
      `${JSON.stringify(configFor(bRoot))}\n`,
    )
    await expect(
      handlers['project.open']!([{ path: bRoot, epoch: 3 }]),
    ).rejects.toThrow(/epoch/)
    await expect(
      handlers['project.open']!([{ path: bRoot, epoch: 4 }]),
    ).rejects.toThrow(/epoch/)
    await handlers['project.close']!([{ project: a.project }])
    expect(sidecar.call).toHaveBeenCalledWith('system.detachProject', [
      { project: a.project },
    ])
    await expect(
      handlers['subjects.markQc']!([
        {
          project: a.project,
          subjectId: 'participant-X9',
          verdict: null,
          note: '',
          tags: [],
        },
      ]),
    ).rejects.toThrow(/stale or unknown/)
  })

  it('serializes host invalidation after an in-flight project replacement', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    await createProject(handlers, join(root, 'a'), 1)
    const bRoot = join(root, 'b')
    await mkdir(bRoot)
    await writeFile(
      join(bRoot, 'supraspina.project.json'),
      `${JSON.stringify(configFor(bRoot))}\n`,
    )
    let releaseDetach!: () => void
    const detachBlocked = new Promise<void>((resolve) => {
      releaseDetach = resolve
    })
    let firstDetach = true
    sidecar.call.mockImplementation(
      async (method: string): Promise<unknown> => {
        if (method === 'system.detachProject') {
          if (firstDetach) {
            firstDetach = false
            await detachBlocked
          }
          return { detached: true, projectAttached: false }
        }
        return null
      },
    )

    const opening = handlers['project.open']!([{ path: bRoot, epoch: 2 }])
    await vi.waitFor(() =>
      expect(sidecar.call).toHaveBeenCalledWith(
        'system.detachProject',
        expect.anything(),
      ),
    )
    const { invalidateActiveProject } = await import('./ipc')
    const invalidating = invalidateActiveProject(sidecar as never)
    releaseDetach()
    const opened = (await opening) as ProjectOpenResult
    await invalidating

    await expect(
      handlers['subjects.markQc']!([
        {
          project: opened.project,
          subjectId: 'participant-X9',
          verdict: null,
          note: '',
          tags: [],
        },
      ]),
    ).rejects.toThrow(/stale or unknown/)
  })
})

describe('single-use capabilities and QC', () => {
  it('binds a save destination to sender, purpose, project, epoch, and one use', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const output = join(root, 'subjects.csv')
    dialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: output,
    })
    const destination = (await handlers['fs.chooseSavePath']!(
      [{ purpose: 'subjects-csv', project: opened.project }],
      { senderId: 7 },
    )) as { destinationId: string }
    const request = {
      project: opened.project,
      rows: [exportRow()],
      destinationId: destination.destinationId,
    }
    // A foreign window must be refused without burning the owner's grant.
    await expect(
      handlers['subjects.exportCsv']!([request], { senderId: 8 }),
    ).rejects.toThrow(/unused, unexpired save destination/)

    await handlers['subjects.exportCsv']!([request], { senderId: 7 })
    const csv = await readFile(output, 'utf8')
    expect(csv).toContain('participant-X9')
    await expect(
      handlers['subjects.exportCsv']!([request], { senderId: 7 }),
    ).rejects.toThrow(/unused, unexpired save destination/)
  })

  it('keeps a mismatched save destination usable and sweeps an expired one', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const output = join(root, 'subjects.csv')
    dialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: output,
    })
    const chooseDestination = async (): Promise<string> =>
      (
        (await handlers['fs.chooseSavePath']!(
          [{ purpose: 'subjects-csv', project: opened.project }],
          { senderId: 7 },
        )) as { destinationId: string }
      ).destinationId
    const destinationId = await chooseDestination()

    // The example-CSV writer consumes a different purpose. Its rejection must
    // leave the export destination the renderer still holds intact.
    await expect(
      handlers['registry.saveExampleCsv']!(
        [{ project: opened.project, destinationId }],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/unused, unexpired save destination/)
    await handlers['subjects.exportCsv']!(
      [{ project: opened.project, destinationId, rows: [exportRow()] }],
      { senderId: 7 },
    )
    expect(await readFile(output, 'utf8')).toContain('participant-X9')

    const expiring = await chooseDestination()
    const exportWith = (id: string): Promise<unknown> =>
      handlers['subjects.exportCsv']!(
        [{ project: opened.project, destinationId: id, rows: [exportRow()] }],
        { senderId: 7 },
      )
    const realNow = Date.now
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + 11 * 60 * 1000)
    await expect(exportWith(expiring)).rejects.toThrow(
      /unused, unexpired save destination/,
    )
    clock.mockRestore()
    // The expired grant stays swept once the clock returns to real time.
    await expect(exportWith(expiring)).rejects.toThrow(
      /unused, unexpired save destination/,
    )
  })

  it('writes the example registry CSV only through a purpose-bound one-use destination', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const output = join(root, 'registry-import-example.csv')
    dialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: output,
    })

    const foreign = (await handlers['fs.chooseSavePath']!(
      [{ purpose: 'registry-import-example', project: opened.project }],
      { senderId: 7 },
    )) as { destinationId: string }
    await expect(
      handlers['registry.saveExampleCsv']!(
        [{ project: opened.project, destinationId: foreign.destinationId }],
        { senderId: 8 },
      ),
    ).rejects.toThrow(/unused, unexpired save destination/)

    const wrongPurpose = (await handlers['fs.chooseSavePath']!(
      [{ purpose: 'subjects-csv', project: opened.project }],
      { senderId: 7 },
    )) as { destinationId: string }
    await expect(
      handlers['registry.saveExampleCsv']!(
        [
          {
            project: opened.project,
            destinationId: wrongPurpose.destinationId,
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/unused, unexpired save destination/)

    const granted = (await handlers['fs.chooseSavePath']!(
      [{ purpose: 'registry-import-example', project: opened.project }],
      { senderId: 7 },
    )) as { destinationId: string }
    await handlers['registry.saveExampleCsv']!(
      [{ project: opened.project, destinationId: granted.destinationId }],
      { senderId: 7 },
    )
    expect(await readFile(output, 'utf8')).toBe(REGISTRY_IMPORT_EXAMPLE_CSV)
    await expect(
      handlers['registry.saveExampleCsv']!(
        [{ project: opened.project, destinationId: granted.destinationId }],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/unused, unexpired save destination/)
  })

  it('escapes CSV cells and tolerates absent optional subject values', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const output = join(root, 'subjects-with-notes.csv')
    dialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: output,
    })
    const destination = (await handlers['fs.chooseSavePath']!(
      [{ purpose: 'subjects-csv', project: opened.project }],
      { senderId: 7 },
    )) as { destinationId: string }

    await handlers['subjects.exportCsv']!(
      [
        {
          project: opened.project,
          destinationId: destination.destinationId,
          rows: [
            exportRow({
              notes: 'review "again",\nwith care',
              cells: [
                { ...emptyCell(), st: 'done' },
                ...Array.from({ length: MATRIX_STEP_COUNT - 1 }, () =>
                  emptyCell(),
                ),
              ],
            }),
          ],
        },
      ],
      { senderId: 7 },
    )

    const csv = await readFile(output, 'utf8')
    expect(csv).toContain('"review ""again"",\nwith care"')
    expect(csv).toContain(',done,pending,pending,pending,pending')
  })

  it('rejects unvalidated export rows and neutralizes formula cells', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const output = join(root, 'formula-subjects.csv')
    dialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: output,
    })
    const chooseDestination = async (): Promise<string> =>
      (
        (await handlers['fs.chooseSavePath']!(
          [{ purpose: 'subjects-csv', project: opened.project }],
          { senderId: 7 },
        )) as { destinationId: string }
      ).destinationId

    await expect(
      handlers['subjects.exportCsv']!(
        [
          {
            project: opened.project,
            destinationId: await chooseDestination(),
            rows: [exportRow({ cohort: 'SCI' })],
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/invalid subject returned by subjects.exportCsv/)
    await expect(
      handlers['subjects.exportCsv']!(
        [
          {
            project: opened.project,
            destinationId: await chooseDestination(),
            rows: Array.from({ length: 1_001 }, () => exportRow()),
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/at most 1000 subject rows/)
    expect(existsSync(output)).toBe(false)

    // A cell opening with =, +, -, or @ executes as a spreadsheet formula.
    await handlers['subjects.exportCsv']!(
      [
        {
          project: opened.project,
          destinationId: await chooseDestination(),
          rows: [
            exportRow({ notes: '=1+1' }),
            exportRow({ id: 'participant-Y2', notes: '@SUM(A1)' }),
            exportRow({ id: 'participant-Z3', age: -3, notes: '+cmd|calc' }),
          ],
        },
      ],
      { senderId: 7 },
    )
    const csv = await readFile(output, 'utf8')
    expect(csv).toContain(",'=1+1,")
    expect(csv).toContain(",'@SUM(A1),")
    expect(csv).toContain(",'+cmd|calc,")
    expect(csv).toContain(",'-3,")
    expect(csv).toContain('participant-X9,SCI_P,35,F,')
  })

  it('serializes QC revisions and bounds sensitive notes and tags', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const { grantIds } = await issueQcReviewGrants(handlers, sidecar, opened)
    const first = await handlers['subjects.markQc']!(
      [
        {
          project: opened.project,
          subjectId: 'participant-X9',
          verdict: 'defer',
          note: 'review later',
          tags: ['motion'],
          reviewGrantIds: grantIds,
          expectedRevision: 0,
        },
      ],
      { senderId: 7 },
    )
    expect(first).toMatchObject({
      revision: 1,
      verdict: 'defer',
      reviewEvidence: {
        evidenceVersion: 1,
        reviewer: expect.stringMatching(/^os-user:/),
        reviewedAt: expect.any(String),
        galleries: expect.arrayContaining([
          expect.objectContaining({ tab: 'subcortical' }),
          expect.objectContaining({ tab: 'internal' }),
          expect.objectContaining({ tab: 'external' }),
        ]),
      },
    })
    await expect(
      handlers['subjects.markQc']!([
        {
          project: opened.project,
          subjectId: 'participant-new',
          verdict: 'pass',
          note: '',
          tags: [],
        },
      ]),
    ).rejects.toThrow(/Open all three current ENIGMA galleries/)
    await expect(
      handlers['subjects.markQc']!([
        {
          project: opened.project,
          subjectId: 'participant-X9',
          verdict: 'pass',
          note: '',
          tags: [],
          expectedRevision: 0,
        },
      ]),
    ).rejects.toThrow(/revision conflict/)
    await expect(
      handlers['subjects.markQc']!([
        {
          project: opened.project,
          subjectId: 'participant-X9',
          verdict: 'pass',
          note: 'x'.repeat(4_097),
          tags: [],
        },
      ]),
    ).rejects.toThrow(/bounded storage/)
  })

  it('accepts six pre-issued grants across two sequential subject reviews', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const grants = await issueSharedQcReviewGrants(handlers, sidecar, opened, [
      'sub-001',
      'sub-002',
    ])

    const first = await handlers['subjects.markQc']!(
      [
        {
          project: opened.project,
          subjectId: 'sub-001',
          verdict: 'pass',
          note: '',
          tags: [],
          reviewGrantIds: grants.get('sub-001'),
          expectedRevision: 0,
        },
      ],
      { senderId: 7 },
    )
    const second = await handlers['subjects.markQc']!(
      [
        {
          project: opened.project,
          subjectId: 'sub-002',
          verdict: 'fail',
          note: 'Visible artifact',
          tags: ['artifact'],
          reviewGrantIds: grants.get('sub-002'),
          expectedRevision: 0,
        },
      ],
      { senderId: 7 },
    )

    expect(first).toMatchObject({ subjectId: 'sub-001', verdict: 'pass' })
    expect(second).toMatchObject({ subjectId: 'sub-002', verdict: 'fail' })
    await expect(
      handlers['subjects.markQc']!(
        [
          {
            project: opened.project,
            subjectId: 'sub-001',
            verdict: 'fail',
            note: '',
            tags: [],
            reviewGrantIds: grants.get('sub-001'),
            expectedRevision: 1,
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/Open the current QC galleries again/)
  })

  it('uses the newest qualifying ENIGMA inventory across newer unrelated runs', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-22222222', 'run-11111111')
    const { grantIds } = await issueQcReviewGrants(handlers, sidecar, opened, {
      inventoryRunId: 'run-11111111',
    })

    await expect(
      handlers['subjects.markQc']!(
        [
          {
            project: opened.project,
            subjectId: 'participant-X9',
            verdict: 'pass',
            note: '',
            tags: [],
            reviewGrantIds: grantIds,
            expectedRevision: 0,
          },
        ],
        { senderId: 7 },
      ),
    ).resolves.toMatchObject({ verdict: 'pass' })
    expect(sidecar.call).toHaveBeenCalledWith('results.list', [
      expect.objectContaining({ runId: 'run-22222222', stepKey: 'enigma' }),
    ])
    expect(sidecar.call).toHaveBeenCalledWith('results.list', [
      expect.objectContaining({ runId: 'run-11111111', stepKey: 'enigma' }),
    ])
  })

  it('skips inventorying a run whose manifest never recorded ENIGMA QC', async () => {
    // Reading one run's inventory is expensive, and a project accumulates
    // runs that produced no gallery.
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-33333333', 'run-11111111')
    sidecar.manifestSteps.set('run-33333333', [{ key: 'recon' }])
    sidecar.manifestSteps.set('run-11111111', [
      { key: 'recon' },
      { key: 'enigma' },
    ])
    await issueQcReviewGrants(handlers, sidecar, opened, {
      inventoryRunId: 'run-11111111',
    })

    const inventoried = sidecar.call.mock.calls
      .filter(([method]) => method === 'results.list')
      .map(([, args]) => (args as [{ runId?: string }])[0]?.runId)
    expect(inventoried).toContain('run-11111111')
    expect(inventoried).not.toContain('run-33333333')
  })

  it('invalidates older grants when a newer qualifying ENIGMA inventory appears', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    const older = await issueQcReviewGrants(handlers, sidecar, opened, {
      inventoryRunId: 'run-11111111',
    })
    sidecar.manifestRunIds.splice(
      0,
      sidecar.manifestRunIds.length,
      'run-22222222',
      'run-11111111',
    )
    await issueQcReviewGrants(handlers, sidecar, opened, {
      inventoryRunId: 'run-22222222',
      receiptSha256: '2'.repeat(64),
    })

    await expect(
      handlers['subjects.markQc']!(
        [
          {
            project: opened.project,
            subjectId: 'participant-X9',
            verdict: 'pass',
            note: '',
            tags: [],
            reviewGrantIds: older.grantIds,
            expectedRevision: 0,
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/authoritative current QC run/)
  })

  it('rejects gallery authority from a different saved config', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))

    await expect(
      issueQcReviewGrants(handlers, sidecar, opened, {
        configSha256: 'f'.repeat(64),
      }),
    ).rejects.toThrow(/current detector-issued ENIGMA gallery/)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('rejects renderer-fabricated evidence and unknown grant identifiers', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const base = {
      project: opened.project,
      subjectId: 'participant-X9',
      verdict: 'pass' as const,
      note: '',
      tags: [],
      expectedRevision: 0,
    }

    await expect(
      handlers['subjects.markQc']!([
        { ...base, reviewEvidence: fabricatedQcReviewEvidence() },
      ]),
    ).rejects.toThrow(/valid QC review grant request/)
    await expect(
      handlers['subjects.markQc']!(
        [
          {
            ...base,
            reviewGrantIds: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/Open the current QC galleries again/)
  })

  it('binds grants to the opening window without consuming them on rejection', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const { grantIds } = await issueQcReviewGrants(handlers, sidecar, opened)
    const request = {
      project: opened.project,
      subjectId: 'participant-X9',
      verdict: 'pass' as const,
      note: '',
      tags: [],
      reviewGrantIds: grantIds,
      expectedRevision: 0,
    }

    await expect(
      handlers['subjects.markQc']!([request], { senderId: 8 }),
    ).rejects.toThrow(/Open the current QC galleries again/)
    await expect(
      handlers['subjects.markQc']!([request], { senderId: 7 }),
    ).resolves.toMatchObject({ verdict: 'pass' })
  })

  it('rejects grants mixed across inventory runs and receipts', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    const older = await issueQcReviewGrants(handlers, sidecar, opened, {
      inventoryRunId: 'run-11111111',
      receiptSha256: '1'.repeat(64),
    })
    sidecar.manifestRunIds.splice(
      0,
      sidecar.manifestRunIds.length,
      'run-22222222',
      'run-11111111',
    )
    const newer = await issueQcReviewGrants(handlers, sidecar, opened, {
      inventoryRunId: 'run-22222222',
      receiptSha256: '2'.repeat(64),
    })

    await expect(
      handlers['subjects.markQc']!(
        [
          {
            project: opened.project,
            subjectId: 'participant-X9',
            verdict: 'fail',
            note: '',
            tags: [],
            reviewGrantIds: [
              older.grantIds[0],
              newer.grantIds[1],
              newer.grantIds[2],
            ],
            expectedRevision: 0,
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/Use QC review grants from one subject/)
  })

  it('rejects grants after a reviewed gallery changes on disk', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const { grantIds, items } = await issueQcReviewGrants(
      handlers,
      sidecar,
      opened,
    )
    await writeFile(
      items[0]!.displayPath,
      '<html>participant-X9 changed</html>',
    )

    await expect(
      handlers['subjects.markQc']!(
        [
          {
            project: opened.project,
            subjectId: 'participant-X9',
            verdict: 'pass',
            note: '',
            tags: [],
            reviewGrantIds: grantIds,
            expectedRevision: 0,
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/changed after opening/)
  })

  it('revokes review grants after a successful project save', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const { grantIds } = await issueQcReviewGrants(handlers, sidecar, opened)
    await handlers['project.save']!([
      {
        project: opened.project,
        cfg: opened.cfg,
        configRevision: 0,
        safeExecution: false,
        expectedSha256: opened.configSha256,
      },
    ])

    await expect(
      handlers['subjects.markQc']!(
        [
          {
            project: opened.project,
            subjectId: 'participant-X9',
            verdict: 'pass',
            note: '',
            tags: [],
            reviewGrantIds: grantIds,
            expectedRevision: 0,
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/Open the current QC galleries again/)
  })

  it('preserves a prior Fail while recording a new reviewed verdict', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const file = await installQcFixture(opened.project.root, 'canonical.json')
    const { grantIds } = await issueQcReviewGrants(handlers, sidecar, opened, {
      subjectId: 'sub-02',
    })

    await handlers['subjects.markQc']!(
      [
        {
          project: opened.project,
          subjectId: 'sub-02',
          verdict: 'pass',
          note: 'now reviewed',
          tags: [],
          reviewGrantIds: grantIds,
          expectedRevision: 1,
        },
      ],
      { senderId: 7 },
    )

    const persisted = JSON.parse(await readFile(file, 'utf8')) as {
      schemaVersion: number
      verdicts: Record<string, { verdict: string | null; revision: number }>
    }
    expect(persisted.schemaVersion).toBe(2)
    expect(persisted.verdicts['sub-01']).toMatchObject({
      verdict: 'fail',
      revision: 4,
    })
    expect(persisted.verdicts['sub-02']).toMatchObject({
      verdict: 'pass',
      revision: 2,
    })
  })

  it('preserves review evidence during an annotation-only edit', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const file = await installQcFixture(opened.project.root, 'canonical.json')

    const result = await handlers['subjects.markQc']!([
      {
        project: opened.project,
        subjectId: 'sub-01',
        verdict: 'fail',
        note: 'Retain the recorded verdict; require fresh review.',
        tags: ['motion'],
        annotationOnly: true,
        expectedRevision: 4,
      },
    ])

    expect(result).toMatchObject({
      verdict: 'fail',
      reviewEvidence: { reviewer: 'fixture-reviewer' },
      revision: 5,
    })
    const persisted = JSON.parse(await readFile(file, 'utf8')) as {
      verdicts: Record<string, { verdict: string; reviewEvidence: unknown }>
    }
    expect(persisted.verdicts['sub-01']).toMatchObject({
      verdict: 'fail',
      reviewEvidence: { reviewer: 'fixture-reviewer' },
    })
  })

  it('records a reviewer note before any verdict without inventing one', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))

    const result = await handlers['subjects.markQc']!([
      {
        project: opened.project,
        subjectId: 'sub-02',
        verdict: null,
        note: 'Check the left hemisphere montage again.',
        tags: [],
        annotationOnly: true,
      },
    ])

    expect(result).toMatchObject({
      verdict: null,
      note: 'Check the left hemisphere montage again.',
      reviewEvidence: null,
      revision: 1,
    })
    await expect(
      handlers['subjects.markQc']!([
        {
          project: opened.project,
          subjectId: 'sub-03',
          verdict: 'pass',
          note: 'A note must not create a verdict.',
          tags: [],
          annotationOnly: true,
        },
      ]),
    ).rejects.toThrow(
      'Preserve the saved verdict when updating a QC annotation.',
    )
  })

  it('preserves the existing QC file mode during an atomic edit', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const file = await installQcFixture(opened.project.root, 'canonical.json')
    await chmod(file, 0o640)
    const { grantIds } = await issueQcReviewGrants(handlers, sidecar, opened, {
      subjectId: 'sub-02',
    })

    await handlers['subjects.markQc']!(
      [
        {
          project: opened.project,
          subjectId: 'sub-02',
          verdict: 'defer',
          note: '',
          tags: [],
          reviewGrantIds: grantIds,
          expectedRevision: 1,
        },
      ],
      { senderId: 7 },
    )

    expect((await stat(file)).mode & 0o777).toBe(0o640)
  })

  it.each([
    'malformed.json',
    'unversioned.json',
    'invalid-revision.json',
    'wrong-shape.json',
  ])('blocks writes to %s without touching persisted bytes', async (name) => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const file = await installQcFixture(opened.project.root, name)
    const original = await readFile(file)

    await expect(
      handlers['subjects.markQc']!([
        {
          project: opened.project,
          subjectId: 'sub-02',
          verdict: 'pass',
          note: '',
          tags: [],
        },
      ]),
    ).rejects.toThrow()
    expect(await readFile(file)).toEqual(original)
  })

  it('blocks an unreadable existing QC store instead of replacing it', async () => {
    if (process.platform === 'win32') return
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const file = await installQcFixture(opened.project.root, 'canonical.json')
    const original = await readFile(file)
    await chmod(file, 0)

    try {
      await expect(
        handlers['subjects.markQc']!([
          {
            project: opened.project,
            subjectId: 'sub-02',
            verdict: 'pass',
            note: '',
            tags: [],
          },
        ]),
      ).rejects.toThrow()
    } finally {
      await chmod(file, 0o600)
    }
    expect(await readFile(file)).toEqual(original)
  })

  it('rejects an oversized existing QC store without replacing its bytes', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const file = join(opened.project.root, '.supraspina', 'qc_verdicts.json')
    await mkdir(join(opened.project.root, '.supraspina'), { recursive: true })
    const original = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20)
    const originalSha256 = createHash('sha256').update(original).digest('hex')
    await writeFile(file, original)

    await expect(
      handlers['subjects.markQc']!([
        {
          project: opened.project,
          subjectId: 'sub-02',
          verdict: null,
          note: '',
          tags: [],
        },
      ]),
    ).rejects.toThrow(/bounded size limit/)
    const persisted = await readFile(file)
    expect(persisted).toHaveLength(original.length)
    expect(createHash('sha256').update(persisted).digest('hex')).toBe(
      originalSha256,
    )
  })

  it('rejects malformed QC identities, verdicts, and tag collections', async () => {
    const { handlers } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const valid = {
      project: opened.project,
      subjectId: 'participant-X9',
      verdict: 'pass',
      note: '',
      tags: [],
    }

    await expect(handlers['subjects.markQc']!([null])).rejects.toThrow(
      /valid QC write request/,
    )
    await expect(
      handlers['subjects.markQc']!([{ ...valid, subjectId: '../escape' }]),
    ).rejects.toThrow(/valid QC subject ID/)
    await expect(
      handlers['subjects.markQc']!([{ ...valid, verdict: 'unknown' }]),
    ).rejects.toThrow(/valid QC verdict/)
    await expect(
      handlers['subjects.markQc']!([{ ...valid, tags: 'motion' }]),
    ).rejects.toThrow(/valid QC tags/)
    await expect(
      handlers['subjects.markQc']!([{ ...valid, tags: [7] }]),
    ).rejects.toThrow(/valid QC tags/)
    await expect(
      handlers['subjects.markQc']!([{ ...valid, note: 7 }]),
    ).rejects.toThrow(/bounded storage/)
    await expect(
      handlers['subjects.markQc']!([
        { ...valid, tags: Array.from({ length: 33 }, () => 'tag') },
      ]),
    ).rejects.toThrow(/bounded storage/)
    await expect(
      handlers['subjects.markQc']!([{ ...valid, tags: ['x'.repeat(65)] }]),
    ).rejects.toThrow(/bounded storage/)
  })
})

describe('native ENIGMA QC montage', () => {
  /** Create one current detector-described gallery and its two panel PNGs. */
  async function seedMontage(
    sidecar: ReturnType<typeof makeSidecar>,
    opened: ProjectOpenResult,
  ): Promise<{
    galleryArtifactId: string
    montagePath: string
    montageBytes: Buffer
  }> {
    const inventoryRunId = 'run-12345678'
    const subjectId = 'sub-001'
    const configSha256 = canonicalConfigDigest(opened.cfg)
    const directory = join(opened.project.root, 'derivatives', 'montage')
    await mkdir(directory, { recursive: true })
    const galleryPath = join(directory, 'subcortical.html')
    await writeFile(galleryPath, `<html><body>${subjectId}</body></html>`)
    const montagePath = join(directory, 'panel_70_20.png')
    const fullPath = join(directory, 'panel_20.png')
    const montageBytes = Buffer.from([1, 2, 3, 4, 5])
    const fullBytes = Buffer.from([9, 8, 7])
    await writeFile(montagePath, montageBytes)
    await writeFile(fullPath, fullBytes)
    const galleryArtifactId = 'artifact-gallery-subcortical'
    const item: ResultArtifact = {
      artifactId: galleryArtifactId,
      label: 'Subcortical QC gallery',
      stepKey: 'enigma',
      subjectId: null,
      kind: 'html',
      presence: 'produced',
      displayPath: galleryPath,
      exists: true,
      openable: true,
      revealable: true,
      runId: inventoryRunId,
      producerNodeId: 'enigma:cohort',
      receiptSha256: '1'.repeat(64),
      provenance: 'current',
    }
    sidecar.artifactPaths.set(galleryArtifactId, {
      path: galleryPath,
      kind: 'file',
      metadata: {
        artifactId: item.artifactId,
        label: item.label,
        stepKey: item.stepKey,
        subjectId: item.subjectId,
        kind: item.kind,
        presence: item.presence,
        displayPath: item.displayPath,
        runId: item.runId,
        producerNodeId: item.producerNodeId,
        receiptSha256: item.receiptSha256,
        provenance: item.provenance,
        inventoryRunId,
        configSha256,
      },
    })
    for (const tab of ['internal', 'external'] as const) {
      const otherPath = join(directory, `${tab}.html`)
      await writeFile(otherPath, `<html><body>${subjectId}</body></html>`)
      sidecar.artifactPaths.set(`artifact-gallery-${tab}`, {
        path: otherPath,
        kind: 'file',
      })
    }
    sidecar.qcPages.set(inventoryRunId, {
      items: [
        item,
        {
          ...item,
          artifactId: 'artifact-gallery-internal',
          label: 'Cortical-internal QC gallery',
          displayPath: join(directory, 'internal.html'),
        },
        {
          ...item,
          artifactId: 'artifact-gallery-external',
          label: 'Cortical-external QC gallery',
          displayPath: join(directory, 'external.html'),
        },
      ],
      nextCursor: null,
      truncated: false,
      runId: inventoryRunId,
      configSha256,
    })
    sidecar.artifactPaths.set('image-montage', {
      path: montagePath,
      kind: 'file',
    })
    sidecar.artifactPaths.set('image-full', { path: fullPath, kind: 'file' })
    sidecar.qcGalleryPanels.set(
      `${inventoryRunId}\u0000subcortical\u0000${subjectId}`,
      {
        runId: inventoryRunId,
        tab: 'subcortical',
        subjectId,
        configSha256,
        panels: [
          {
            key: 'axial-20',
            group: 'Axial',
            detail: '20%',
            label: 'Axial 20%',
            montage: {
              artifactId: 'image-montage',
              relativePath: 'sub-001/Subcortical_set_Axial_70_20.png',
              displayPath: 'derivatives/montage/panel_70_20.png',
              bytes: montageBytes.byteLength,
              sha256: createHash('sha256').update(montageBytes).digest('hex'),
            },
            full: {
              artifactId: 'image-full',
              relativePath: 'sub-001/Subcortical_set_Axial_20.png',
              displayPath: 'derivatives/montage/panel_20.png',
              bytes: fullBytes.byteLength,
              sha256: createHash('sha256').update(fullBytes).digest('hex'),
            },
          },
        ],
      },
    )
    return { galleryArtifactId, montagePath, montageBytes }
  }

  it('attests in-app review only after every verified panel was displayed', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    const request = {
      project: opened.project,
      artifactId: galleryArtifactId,
      subjectId: 'sub-001',
    }

    const view = (await handlers['qc.galleryImages']!([request], {
      senderId: 7,
    })) as { tab: string; panels: Array<{ montage: { artifactId: string } }> }
    expect(view.tab).toBe('subcortical')
    expect(view.panels).toHaveLength(1)

    await expect(
      handlers['qc.attestGalleryView']!([request], { senderId: 7 }),
    ).rejects.toThrow(/Display the complete QC montage/)

    await handlers['artifact.previewImage']!(
      [{ project: opened.project, artifactId: 'image-montage' }],
      { senderId: 7 },
    )
    const attested = (await handlers['qc.attestGalleryView']!([request], {
      senderId: 7,
    })) as { reviewGrant: QcReviewOpenGrant }
    expect(attested.reviewGrant.tab).toBe('subcortical')
    expect(attested.reviewGrant.subjectId).toBe('sub-001')
    expect(attested.reviewGrant.runId).toBe('run-12345678')
  })

  it('passes on the evidence that a verdict predates the shown images', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    const request = {
      project: opened.project,
      artifactId: galleryArtifactId,
      subjectId: 'sub-001',
    }
    const key = `run-12345678\u0000subcortical\u0000sub-001`
    const described = sidecar.qcGalleryPanels.get(key) as Record<
      string,
      unknown
    >

    const plain = (await handlers['qc.galleryImages']!([request], {
      senderId: 7,
    })) as Record<string, unknown>
    expect(plain).not.toHaveProperty('imagesChangedSinceVerdict')

    const change = { renderedRunId: 'run-87654321', reason: 'inputs-changed' }
    sidecar.qcGalleryPanels.set(key, {
      ...described,
      imagesChangedSinceVerdict: change,
    })
    const flagged = (await handlers['qc.galleryImages']!([request], {
      senderId: 7,
    })) as Record<string, unknown>
    expect(flagged.imagesChangedSinceVerdict).toEqual(change)

    sidecar.qcGalleryPanels.set(key, {
      ...described,
      imagesChangedSinceVerdict: { ...change, reason: 'no-record' },
    })
    await expect(
      handlers['qc.galleryImages']!([request], { senderId: 7 }),
    ).rejects.toThrow(/replaced-images evidence/)
  })

  it('releases full-resolution image records when a gallery view is forgotten', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    const request = {
      project: opened.project,
      artifactId: galleryArtifactId,
      subjectId: 'sub-001',
    }
    await handlers['qc.galleryImages']!([request], { senderId: 7 })
    await handlers['artifact.previewImage']!(
      [{ project: opened.project, artifactId: 'image-full' }],
      { senderId: 7 },
    )

    // Expire the view so attestation forgets it, then prove the full-image
    // record went with it: a leaked record would still bind these bytes.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000)
      await expect(
        handlers['qc.attestGalleryView']!([request], { senderId: 7 }),
      ).rejects.toThrow(/no longer current/)
    } finally {
      vi.useRealTimers()
    }
    const fullPath = join(
      opened.project.root,
      'derivatives',
      'montage',
      'panel_20.png',
    )
    await writeFile(fullPath, Buffer.from([4, 4, 4, 4]))

    await expect(
      handlers['artifact.previewImage']!(
        [{ project: opened.project, artifactId: 'image-full' }],
        { senderId: 7 },
      ),
    ).resolves.toMatchObject({ mimeType: 'image/png' })
  })

  it('clears gallery views and images when a project boundary is crossed', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    await handlers['qc.galleryImages']!(
      [
        {
          project: opened.project,
          artifactId: galleryArtifactId,
          subjectId: 'sub-001',
        },
      ],
      { senderId: 7 },
    )

    const reopened = (await handlers['project.open']!([
      { path: join(root, 'project'), epoch: 2 },
    ])) as ProjectOpenResult
    // A retained record from the prior epoch would refuse this preview as a
    // stale image grant.
    await expect(
      handlers['artifact.previewImage']!(
        [{ project: reopened.project, artifactId: 'image-montage' }],
        { senderId: 7 },
      ),
    ).resolves.toMatchObject({ mimeType: 'image/png' })
  })

  it('refuses a montage image whose bytes no longer match the detector', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId, montagePath } = await seedMontage(
      sidecar,
      opened,
    )
    await handlers['qc.galleryImages']!(
      [
        {
          project: opened.project,
          artifactId: galleryArtifactId,
          subjectId: 'sub-001',
        },
      ],
      { senderId: 7 },
    )
    await writeFile(montagePath, Buffer.from([5, 4, 3, 2, 1]))
    await expect(
      handlers['artifact.previewImage']!(
        [{ project: opened.project, artifactId: 'image-montage' }],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/changed after verification/)
  })

  it('re-resolves the gallery authority when minting review evidence', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    const request = {
      project: opened.project,
      artifactId: galleryArtifactId,
      subjectId: 'sub-001',
    }
    const authorityCalls = (): number =>
      sidecar.call.mock.calls.filter(([method]) => method === 'manifest.list')
        .length

    await handlers['qc.galleryImages']!([request], { senderId: 7 })
    const afterFirstView = authorityCalls()
    expect(afterFirstView).toBeGreaterThan(0)

    await handlers['qc.galleryImages']!([request], { senderId: 7 })
    expect(authorityCalls()).toBe(afterFirstView)

    await handlers['artifact.previewImage']!(
      [{ project: opened.project, artifactId: 'image-montage' }],
      { senderId: 7 },
    )
    await handlers['qc.attestGalleryView']!([request], { senderId: 7 })
    expect(authorityCalls()).toBeGreaterThan(afterFirstView)
  })

  it('signs every gallery authority inventory with the app runtime', async () => {
    // Without the managed-resource runtime the sidecar signs the Brain FOV
    // action as unresolved, so every ENIGMA receipt reads as stale while
    // Results, which sends the runtime, reads the same gallery as current.
    const userDataPath = join(root, 'user-data')
    const sidecar = makeSidecar()
    const runtime = sidecar.call.getMockImplementation()!
    sidecar.call.mockImplementation(async (method: string, args: unknown[]) => {
      const result = await runtime(method, args)
      if (method !== 'results.list') return result
      const request = args[0] as { runtimeContext?: { userDataPath?: string } }
      if (request.runtimeContext?.userDataPath === userDataPath) return result
      const page = result as { items: ResultArtifact[] }
      return {
        ...page,
        items: page.items.map((item) => ({ ...item, provenance: 'stale' })),
      }
    })
    const { handlers } = await freshHandlers(sidecar, { userDataPath })
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    const request = {
      project: opened.project,
      artifactId: galleryArtifactId,
      subjectId: 'sub-001',
    }

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual({
      runId: 'run-12345678',
      unavailable: null,
      inventoryKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    await expect(
      handlers['qc.galleryImages']!([request], { senderId: 7 }),
    ).resolves.toMatchObject({ inventoryRunId: 'run-12345678' })
    await handlers['artifact.previewImage']!(
      [{ project: opened.project, artifactId: 'image-montage' }],
      { senderId: 7 },
    )
    await expect(
      handlers['qc.attestGalleryView']!([request], { senderId: 7 }),
    ).resolves.toMatchObject({ reviewGrant: { runId: 'run-12345678' } })

    const inventories = sidecar.call.mock.calls.filter(
      ([method]) => method === 'results.list',
    )
    expect(inventories.length).toBeGreaterThan(0)
    for (const [, args] of inventories) {
      expect(args).toEqual([
        expect.objectContaining({ runtimeContext: { userDataPath } }),
      ])
    }
  })

  it('omits the runtime context when the app has no valid storage path', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar, {
      userDataPath: 'relative/user-data',
    })
    const opened = await createProject(handlers, join(root, 'project'))
    await seedMontage(sidecar, opened)

    await handlers['qc.authoritativeRun']!([{ project: opened.project }])
    const inventories = sidecar.call.mock.calls.filter(
      ([method]) => method === 'results.list',
    )
    expect(inventories.length).toBeGreaterThan(0)
    for (const [, args] of inventories) {
      expect((args as [Record<string, unknown>])[0]).not.toHaveProperty(
        'runtimeContext',
      )
    }
  })

  it('refuses a montage from a run that is not authoritative without another sweep', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-22222222', 'run-11111111')
    sidecar.manifestExtras.set('run-22222222', {
      startedAt: '2026-09-23T16:21:03.000Z',
    })
    await installQcGalleryRun(sidecar, opened, 'run-22222222', {
      receiptSha256: '2'.repeat(64),
    })
    const older = await installQcGalleryRun(sidecar, opened, 'run-11111111')

    await expect(
      handlers['qc.authoritativeRun']!([{ project: opened.project }]),
    ).resolves.toEqual({
      runId: 'run-22222222',
      unavailable: null,
      inventoryKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const afterAuthority = qcSweepCalls(sidecar)

    await expect(
      handlers['qc.galleryImages']!(
        [
          {
            project: opened.project,
            artifactId: older[0]!.artifactId,
            subjectId: 'sub-001',
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(
      /^Montages and verdicts use the current ENIGMA run, the run started .+\. Select Current ENIGMA run in QC artifact run to review galleries\.$/,
    )
    expect(qcSweepCalls(sidecar)).toEqual(afterAuthority)
    expect(sidecar.call).not.toHaveBeenCalledWith(
      'results.qcGalleryImages',
      expect.anything(),
    )
  })

  it('refuses a montage while no run is authoritative and says why', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    sidecar.manifestRunIds.push('run-11111111')
    const earlier = await installQcGalleryRun(sidecar, opened, 'run-11111111', {
      provenance: 'stale',
    })

    await handlers['qc.authoritativeRun']!([{ project: opened.project }])
    const afterAuthority = qcSweepCalls(sidecar)

    await expect(
      handlers['qc.galleryImages']!(
        [
          {
            project: opened.project,
            artifactId: earlier[0]!.artifactId,
            subjectId: 'sub-001',
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(
      'Montages and verdicts use the current ENIGMA run, and none exists. ' +
        'The newest ENIGMA QC galleries are out of date because an ENIGMA QC input changed after they were produced. ' +
        'Rerun ENIGMA QC to review galleries.',
    )
    expect(qcSweepCalls(sidecar)).toEqual(afterAuthority)
  })

  it('describes every montage of one review from the cached authority', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    const request = {
      project: opened.project,
      artifactId: galleryArtifactId,
      subjectId: 'sub-001',
    }
    await handlers['qc.authoritativeRun']!([{ project: opened.project }])
    const afterAuthority = qcSweepCalls(sidecar)

    for (let view = 0; view < 5; view += 1) {
      await handlers['qc.galleryImages']!([request], { senderId: 7 })
    }
    expect(qcSweepCalls(sidecar)).toEqual(afterAuthority)
  })

  it('attests against the unchanged store without inventorying it again', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    const request = {
      project: opened.project,
      artifactId: galleryArtifactId,
      subjectId: 'sub-001',
    }
    await handlers['qc.galleryImages']!([request], { senderId: 7 })
    await handlers['artifact.previewImage']!(
      [{ project: opened.project, artifactId: 'image-montage' }],
      { senderId: 7 },
    )
    const beforeAttestation = qcSweepCalls(sidecar)

    await expect(
      handlers['qc.attestGalleryView']!([request], { senderId: 7 }),
    ).resolves.toMatchObject({ reviewGrant: { runId: 'run-12345678' } })
    // Attestation observes the durable runs directly but reuses the verdict
    // of a run whose manifest is unchanged.
    const afterAttestation = qcSweepCalls(sidecar)
    expect(afterAttestation.manifests).toBeGreaterThan(
      beforeAttestation.manifests,
    )
    expect(afterAttestation.inventories).toBe(beforeAttestation.inventories)
  })

  it('refuses attestation once a newer authoritative run appears', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const { galleryArtifactId } = await seedMontage(sidecar, opened)
    const request = {
      project: opened.project,
      artifactId: galleryArtifactId,
      subjectId: 'sub-001',
    }
    await handlers['qc.galleryImages']!([request], { senderId: 7 })
    await handlers['artifact.previewImage']!(
      [{ project: opened.project, artifactId: 'image-montage' }],
      { senderId: 7 },
    )
    sidecar.manifestRunIds.push('run-22222222', 'run-12345678')
    await installQcGalleryRun(sidecar, opened, 'run-22222222', {
      receiptSha256: '2'.repeat(64),
    })

    await expect(
      handlers['qc.attestGalleryView']!([request], { senderId: 7 }),
    ).rejects.toThrow(/authoritative current ENIGMA run/)
    const inventoried = sidecar.call.mock.calls
      .filter(([method]) => method === 'results.list')
      .map(([, args]) => (args as [{ runId?: string }])[0]?.runId)
    expect(inventoried).toContain('run-22222222')
  })

  it('refuses a montage for an artifact that is not a current QC gallery', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    await seedMontage(sidecar, opened)
    const other = join(opened.project.root, 'derivatives', 'other.html')
    await writeFile(other, '<html></html>')
    sidecar.artifactPaths.set('artifact-other', { path: other, kind: 'file' })
    await expect(
      handlers['qc.galleryImages']!(
        [
          {
            project: opened.project,
            artifactId: 'artifact-other',
            subjectId: 'sub-001',
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/current detector-issued ENIGMA gallery/)
  })
})

describe('opaque artifact validation', () => {
  it('opens verified files but keeps directories reveal/list-only', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const derivatives = join(projectRoot, 'derivatives')
    const output = join(derivatives, 'result.txt')
    const directory = join(derivatives, 'gallery')
    await mkdir(directory, { recursive: true })
    await writeFile(output, 'verified output')
    sidecar.artifactPaths.set('output', { path: output, kind: 'file' })
    sidecar.artifactPaths.set('gallery', {
      path: directory,
      kind: 'directory',
    })

    await handlers['artifact.open']!([
      { project: opened.project, artifactId: 'output' },
    ])
    await expect(
      handlers['artifact.open']!([
        { project: opened.project, artifactId: 'gallery' },
      ]),
    ).rejects.toThrow(/verified local file/)
    expect(shell.openPath).toHaveBeenCalledTimes(1)
    expect(shell.openPath).toHaveBeenCalledWith(output)
  })

  it('reveals and lists a directory artifact whose metadata carries kind dir', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const subjectDirectory = join(projectRoot, 'derivatives', 'sub-001')
    await mkdir(subjectDirectory, { recursive: true })
    await writeFile(join(subjectDirectory, 'volume.nii'), 'recon output')
    sidecar.artifactPaths.set('subject-dir', {
      path: subjectDirectory,
      kind: 'directory',
      metadata: {
        artifactId: 'subject-dir',
        label: 'FreeSurfer subject directory',
        stepKey: 'recon',
        subjectId: 'sub-001',
        kind: 'dir',
        presence: 'produced',
        displayPath: subjectDirectory,
        runId: 'run-12345678',
        producerNodeId: 'recon:sub-001',
        receiptSha256: '1'.repeat(64),
        provenance: 'current',
        inventoryRunId: 'run-12345678',
        configSha256: canonicalConfigDigest(opened.cfg),
      },
    })

    await handlers['artifact.reveal']!([
      { project: opened.project, artifactId: 'subject-dir' },
    ])
    expect(shell.showItemInFolder).toHaveBeenCalledWith(subjectDirectory)
    const page = (await handlers['artifact.list']!([
      { project: opened.project, artifactId: 'subject-dir' },
    ])) as { items: ResultArtifact[] }
    expect(page.items.map((item) => item.displayPath)).toContain('volume.nii')

    // No step declared this child, so the parent receipt does not cover it.
    const child = page.items.find((item) => item.displayPath === 'volume.nii')!
    expect(child).toMatchObject({
      stepKey: 'recon',
      subjectId: 'sub-001',
      kind: 'nii',
      runId: null,
      producerNodeId: null,
      receiptSha256: null,
      provenance: 'unknown',
      provenanceDetails: null,
    })
    expect(sidecar.artifactPaths.get('subject-dir')!.metadata).toMatchObject({
      runId: 'run-12345678',
      producerNodeId: 'recon:sub-001',
      receiptSha256: '1'.repeat(64),
      provenance: 'current',
    })
    await handlers['artifact.open']!([
      { project: opened.project, artifactId: child.artifactId },
    ])
    expect(shell.openPath).toHaveBeenCalledWith(
      join(subjectDirectory, 'volume.nii'),
    )
  })

  it('requires trusted ENIGMA metadata before focusing an HTML gallery', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const gallery = join(projectRoot, 'derivatives', 'qc-gallery.html')
    await mkdir(join(projectRoot, 'derivatives'), { recursive: true })
    await writeFile(gallery, '<html><body>sub-001</body></html>')
    sidecar.artifactPaths.set('qc-gallery', { path: gallery, kind: 'file' })

    await handlers['artifact.open']!([
      { project: opened.project, artifactId: 'qc-gallery' },
    ])
    await expect(
      handlers['artifact.open']!([
        {
          project: opened.project,
          artifactId: 'qc-gallery',
          focusText: 'sub-001',
        },
      ]),
    ).rejects.toThrow(/current detector-issued ENIGMA gallery/)
    expect(shell.openPath).toHaveBeenCalledWith(gallery)
    expect(shell.openExternal).not.toHaveBeenCalled()
    await expect(
      handlers['artifact.open']!([
        {
          project: opened.project,
          artifactId: 'qc-gallery',
          focusText: 'sub-999',
        },
      ]),
    ).rejects.toThrow(/present in this verified gallery/)
  })

  it('refuses a focus grant for a subject whose ID only prefixes another', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const items = await installSharedQcGalleries(
      sidecar,
      opened,
      '<html><body>sub-011</body></html>',
    )

    // The subject sub-01 owns no panel in these bytes, so the prefix must not
    // mint the grant that later records a durable QC verdict for sub-01.
    await expect(
      handlers['artifact.open']!(
        [
          {
            project: opened.project,
            artifactId: items[0]!.artifactId,
            focusText: 'sub-01',
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/present in this verified gallery/)
    const exact = (await handlers['artifact.open']!(
      [
        {
          project: opened.project,
          artifactId: items[0]!.artifactId,
          focusText: 'sub-011',
        },
      ],
      { senderId: 7 },
    )) as { reviewGrant: QcReviewOpenGrant | null }
    expect(exact.reviewGrant).toMatchObject({ subjectId: 'sub-011' })
  })

  it('accepts a focused subject at a buffer or markup boundary', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const opened = await createProject(handlers, join(root, 'project'))
    const items = await installSharedQcGalleries(sidecar, opened, 'sub-002')

    const bare = (await handlers['artifact.open']!(
      [
        {
          project: opened.project,
          artifactId: items[0]!.artifactId,
          focusText: 'sub-002',
        },
      ],
      { senderId: 7 },
    )) as { reviewGrant: QcReviewOpenGrant | null }
    expect(bare.reviewGrant).toMatchObject({ subjectId: 'sub-002' })

    const quoted = await installSharedQcGalleries(
      sidecar,
      opened,
      '<img alt="sub-002" src="sub-002.png">',
    )
    const markup = (await handlers['artifact.open']!(
      [
        {
          project: opened.project,
          artifactId: quoted[0]!.artifactId,
          focusText: 'sub-002',
        },
      ],
      { senderId: 7 },
    )) as { reviewGrant: QcReviewOpenGrant | null }
    expect(markup.reviewGrant).toMatchObject({ subjectId: 'sub-002' })
  })

  it('keeps the delimited subject rule on the grant file re-check', async () => {
    const { handlers, sidecar } = await freshHandlers()
    const opened = await createProject(handlers, join(root, 'project'))
    const grants = await issueSharedQcReviewGrants(handlers, sidecar, opened, [
      'sub-011',
    ])

    await expect(
      handlers['subjects.markQc']!(
        [
          {
            project: opened.project,
            subjectId: 'sub-011',
            verdict: 'pass',
            note: '',
            tags: [],
            reviewGrantIds: grants.get('sub-011'),
            expectedRevision: 0,
          },
        ],
        { senderId: 7 },
      ),
    ).resolves.toMatchObject({ subjectId: 'sub-011', verdict: 'pass' })
  })

  it('opens detector-owned output but rejects raw/config paths and direct symlinks', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const derivatives = join(projectRoot, 'derivatives')
    const raw = join(projectRoot, 'rawdata')
    await mkdir(derivatives, { recursive: true })
    await mkdir(raw, { recursive: true })
    const output = join(derivatives, 'result.txt')
    const rawT1 = join(raw, 'participant-X9_T1w.nii.gz')
    await writeFile(output, 'verified output')
    await writeFile(rawT1, 'sensitive raw input')
    const link = join(derivatives, 'linked.txt')
    await symlink(output, link)
    sidecar.artifactPaths.set('output', { path: output, kind: 'file' })
    sidecar.artifactPaths.set('raw', { path: rawT1, kind: 'file' })
    sidecar.artifactPaths.set('config', {
      path: join(projectRoot, 'supraspina.project.json'),
      kind: 'file',
    })
    sidecar.artifactPaths.set('link', { path: link, kind: 'file' })

    await expect(
      handlers['artifact.readText']!([
        { project: opened.project, artifactId: 'output' },
      ]),
    ).resolves.toEqual({ text: 'verified output', truncated: false })
    await expect(
      handlers['artifact.readText']!([
        { project: opened.project, artifactId: 'raw' },
      ]),
    ).rejects.toThrow(/only from active project output roots/)
    await expect(
      handlers['artifact.readText']!([
        { project: opened.project, artifactId: 'config' },
      ]),
    ).rejects.toThrow(/only from active project output roots/)
    await expect(
      handlers['artifact.readText']!([
        { project: opened.project, artifactId: 'link' },
      ]),
    ).rejects.toThrow(/symlink/)
  })

  it('rejects configured output roots that widen to the project and raw tree', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const cfg = configFor(projectRoot)
    cfg.paths.derivativesDir = projectRoot
    cfg.paths.outputDir = projectRoot
    cfg.paths.qcOutputDir = projectRoot
    cfg.outputs.rootDir = projectRoot
    cfg.outputs.runDir = projectRoot

    await expect(
      handlers['project.create']!([{ at: projectRoot, cfg, epoch: 1 }]),
    ).rejects.toThrow(
      /Keep paths\.derivativesDir separate from paths\.rawdataDir/,
    )
  })

  it('rejects an output-root symlink that canonically widens to the project', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    await mkdir(projectRoot)
    const linkedOutput = join(root, 'linked-output')
    await symlink(projectRoot, linkedOutput, 'dir')
    const cfg = configFor(projectRoot)
    cfg.paths.derivativesDir = linkedOutput
    const opened = (await handlers['project.create']!([
      { at: projectRoot, cfg, epoch: 1 },
    ])) as ProjectOpenResult
    const configPath = join(projectRoot, 'supraspina.project.json')
    sidecar.artifactPaths.set('config-via-output-symlink', {
      path: configPath,
      kind: 'file',
    })

    await expect(
      handlers['artifact.readText']!([
        {
          project: opened.project,
          artifactId: 'config-via-output-symlink',
        },
      ]),
    ).rejects.toThrow(/only from active project output roots/)
  })

  it('rejects a file swapped to a symlink between validation and descriptor open', async () => {
    const sidecar = makeSidecar()
    const projectRoot = join(root, 'project')
    let output = ''
    let outside = ''
    let swapped = false
    const { handlers } = await freshHandlers(sidecar, {
      artifactUseBarrier: async (candidate) => {
        if (candidate !== output || swapped) return
        swapped = true
        await unlink(output)
        await symlink(outside, output)
      },
    })
    const opened = await createProject(handlers, projectRoot)
    const derivatives = join(projectRoot, 'derivatives')
    await mkdir(derivatives, { recursive: true })
    output = join(derivatives, 'result.txt')
    outside = join(root, 'outside.txt')
    await writeFile(output, 'verified output')
    await writeFile(outside, 'private neighbor')
    sidecar.artifactPaths.set('output', { path: output, kind: 'file' })

    await expect(
      handlers['artifact.readText']!([
        { project: opened.project, artifactId: 'output' },
      ]),
    ).rejects.toThrow(/changed after validation/)
    expect(swapped).toBe(true)
  })

  it('bounds directory enumeration and exposes only basename display paths', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const gallery = join(projectRoot, 'derivatives', 'gallery')
    await mkdir(gallery, { recursive: true })
    for (let index = 0; index < 1_001; index += 1) {
      await writeFile(join(gallery, `image-${index}.txt`), 'bounded')
    }
    sidecar.artifactPaths.set('gallery', {
      path: gallery,
      kind: 'directory',
    })

    const page = (await handlers['artifact.list']!([
      { project: opened.project, artifactId: 'gallery', limit: 1_000 },
    ])) as {
      items: Array<{ displayPath: string }>
      truncated: boolean
    }
    expect(page.items).toHaveLength(1_000)
    expect(page.truncated).toBe(true)
    expect(page.items.every((item) => !item.displayPath.includes('/'))).toBe(
      true,
    )
    expect(
      page.items.every((item) => !item.displayPath.includes(projectRoot)),
    ).toBe(true)
  })

  it('classifies bounded directory pages by reviewable artifact type', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const gallery = join(projectRoot, 'derivatives', 'typed-gallery')
    await mkdir(join(gallery, 'nested'), { recursive: true })
    const names = [
      'data.csv',
      'image.png',
      'photo.jpg',
      'photo.jpeg',
      'image.webp',
      'report.html',
      'report.htm',
      'table.xlsx',
      'paper.pdf',
      'volume.nii',
      'volume.nii.gz',
      'notes.unknown',
    ]
    await Promise.all(names.map((name) => writeFile(join(gallery, name), name)))
    sidecar.artifactPaths.set('typed-gallery', {
      path: gallery,
      kind: 'directory',
    })

    const first = (await handlers['artifact.list']!([
      {
        project: opened.project,
        artifactId: 'typed-gallery',
        cursor: 'not-a-cursor',
        limit: 5,
      },
    ])) as {
      items: Array<{ displayPath: string; kind: string }>
      nextCursor: string | null
      truncated: boolean
    }
    expect(first.items).toHaveLength(5)
    expect(first.nextCursor).toBe('5')
    expect(first.truncated).toBe(true)

    const all = (await handlers['artifact.list']!([
      {
        project: opened.project,
        artifactId: 'typed-gallery',
        cursor: 0,
        limit: Number.NaN,
      },
    ])) as {
      items: Array<{ displayPath: string; kind: string }>
      nextCursor: string | null
      truncated: boolean
    }
    expect(
      Object.fromEntries(
        all.items.map((item) => [item.displayPath, item.kind]),
      ),
    ).toMatchObject({
      'data.csv': 'csv',
      'image.png': 'png',
      'photo.jpg': 'png',
      'photo.jpeg': 'png',
      'image.webp': 'png',
      'report.html': 'html',
      'report.htm': 'html',
      'table.xlsx': 'xlsx',
      'paper.pdf': 'pdf',
      'volume.nii': 'nii',
      'volume.nii.gz': 'nii',
      'notes.unknown': 'txt',
    })
    expect(all.nextCursor).toBeNull()
    expect(all.truncated).toBe(false)
  })

  it('previews only bounded PNG, JPEG, and WebP files', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const derivatives = join(projectRoot, 'derivatives')
    await mkdir(derivatives, { recursive: true })
    sidecar.artifactPaths.set('directory', {
      path: derivatives,
      kind: 'directory',
    })
    for (const [id, name] of [
      ['png', 'image.png'],
      ['jpg', 'image.jpg'],
      ['jpeg', 'image.jpeg'],
      ['webp', 'image.webp'],
      ['gif', 'image.gif'],
    ] as const) {
      const path = join(derivatives, name)
      await writeFile(path, Buffer.from([0, 1, 2, 3]))
      sidecar.artifactPaths.set(id, { path, kind: 'file' })
    }

    for (const [id, mimeType] of [
      ['png', 'image/png'],
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
    ] as const) {
      await expect(
        handlers['artifact.previewImage']!([
          { project: opened.project, artifactId: id, maxBytes: 10 },
        ]),
      ).resolves.toMatchObject({ mimeType, truncated: false })
    }
    await expect(
      handlers['artifact.previewImage']!([
        { project: opened.project, artifactId: 'gif' },
      ]),
    ).rejects.toThrow(/supported PNG, JPEG, or WebP/)
    await expect(
      handlers['artifact.previewImage']!([
        { project: opened.project, artifactId: 'png', maxBytes: 1 },
      ]),
    ).rejects.toThrow(/within the preview size limit/)
    await expect(
      handlers['artifact.previewImage']!([
        { project: opened.project, artifactId: 'directory' },
      ]),
    ).rejects.toThrow(/file artifact before previewing/)
  })
})

describe('subject log evidence', () => {
  it('accepts pipeline stage keys and rejects matrix-only aliases', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const log = join(
      projectRoot,
      '.supraspina',
      'runs',
      'run-12345678',
      'logs',
      'deface.log',
    )
    await mkdir(join(log, '..'), { recursive: true })
    await writeFile(log, 'durable deface log')
    sidecar.runtimeJobs.push({
      id: '#deface',
      projectId: opened.project.projectId,
      projectEpoch: opened.project.epoch,
      subjectId: 'participant-X9',
      stepKey: 'deface',
      stdoutPath: log,
      dryRun: false,
      endedAt: 100,
    })

    await handlers['subjects.openLog']!([
      {
        project: opened.project,
        subjectId: 'participant-X9',
        stepKey: 'deface',
      },
    ])
    await expect(
      handlers['subjects.openLog']!([
        {
          project: opened.project,
          subjectId: 'participant-X9',
          stepKey: 'qcsub',
        },
      ]),
    ).rejects.toThrow(/valid subject log step/)
    expect(shell.openPath).toHaveBeenCalledWith(log)
  })

  it('opens only a durable runtime job log under the active run store', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const log = join(
      projectRoot,
      '.supraspina',
      'runs',
      'run-12345678',
      'logs',
      'abc.log',
    )
    await mkdir(join(log, '..'), { recursive: true })
    await writeFile(log, 'durable runtime log')
    sidecar.runtimeJobs.push({
      id: '#abc',
      projectId: opened.project.projectId,
      projectEpoch: opened.project.epoch,
      subjectId: 'participant-X9',
      stepKey: 'recon',
      stdoutPath: log,
      dryRun: false,
      endedAt: 100,
    })

    await expect(
      handlers['subjects.openLog']!([
        {
          project: opened.project,
          subjectId: 'participant-X9',
          stepKey: 'not-a-stage',
        },
      ]),
    ).rejects.toThrow(/valid subject log step/)

    await handlers['subjects.openLog']!([
      {
        project: opened.project,
        subjectId: 'participant-X9',
        stepKey: 'recon',
      },
    ])
    expect(sidecar.call).toHaveBeenCalledWith('runtime.bootstrap', [
      { project: opened.project, runLimit: 200, logLimit: 0 },
    ])
    expect(shell.openPath).toHaveBeenCalledWith(log)
  })

  it('does not infer an obsolete log layout without runtime evidence', async () => {
    const sidecar = makeSidecar()
    const { handlers } = await freshHandlers(sidecar)
    const projectRoot = join(root, 'project')
    const opened = await createProject(handlers, projectRoot)
    const guessed = join(
      projectRoot,
      '.supraspina',
      'runs',
      'run-12345678',
      'recon',
      'participant-X9.log',
    )
    await mkdir(join(guessed, '..'), { recursive: true })
    await writeFile(guessed, 'not authoritative')

    await expect(
      handlers['subjects.openLog']!([
        {
          project: opened.project,
          subjectId: 'participant-X9',
          stepKey: 'recon',
        },
      ]),
    ).rejects.toThrow(/Generate a persisted log/)
    expect(shell.openPath).not.toHaveBeenCalled()
  })
})

describe('update lifecycle gate', () => {
  it('routes install through the shared boundary and never installs directly', async () => {
    vi.resetModules()
    const request = vi.fn(async () => undefined)
    const { nativeHandlers } = await import('./ipc')
    const handlers = nativeHandlers({
      lifecycle: {
        request,
        respond: vi.fn(async () => undefined),
      },
    })
    await handlers['update.installNow']!([])
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('update-install')
  })
})
