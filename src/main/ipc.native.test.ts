import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version as APP_VERSION } from '../../package.json'
import {
  DEFAULT_PROJECT_CONFIG,
  type ProjectConfig,
} from '../shared/project-schema'
import type { ProjectOpenResult } from '../shared/contract'

const mocks = vi.hoisted(() => ({
  windows: [] as Array<{
    webContents: { id: number }
    minimize: ReturnType<typeof vi.fn>
    isMaximized: ReturnType<typeof vi.fn>
    maximize: ReturnType<typeof vi.fn>
    unmaximize: ReturnType<typeof vi.fn>
  }>,
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  openExternal: vi.fn(async () => undefined),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
  updateCheck: vi.fn(async () => ({
    available: false,
    version: null,
    releaseNotes: null,
  })),
  updateDownload: vi.fn(async () => undefined),
  updateStatus: vi.fn(async () => ({
    phase: 'idle',
    version: null,
    releaseNotes: null,
    percent: null,
    error: null,
    capability: 'disabled',
  })),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => mocks.windows,
    fromWebContents: () => null,
  },
  dialog: {
    showOpenDialog: mocks.showOpenDialog,
    showSaveDialog: mocks.showSaveDialog,
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: {
    openExternal: mocks.openExternal,
    openPath: mocks.openPath,
    showItemInFolder: mocks.showItemInFolder,
  },
}))

vi.mock('./autoupdate', () => ({
  autoUpdate: {
    check: mocks.updateCheck,
    download: mocks.updateDownload,
    getStatus: mocks.updateStatus,
  },
}))

interface HandlerContext {
  senderId: number
}

type Handler = (args: unknown[], context?: HandlerContext) => Promise<unknown>

function configFor(root: string): ProjectConfig {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  cfg.project.name = 'Native handler coverage'
  cfg.project.createdAt = '2026-07-22T00:00:00.000Z'
  cfg.paths.projectRoot = root
  return cfg
}

async function freshHandlers(services: Record<string, unknown> = {}) {
  vi.resetModules()
  const { nativeHandlers } = await import('./ipc')
  return nativeHandlers(services as never) as Record<string, Handler>
}

async function createProject(
  handlers: Record<string, Handler>,
  root: string,
): Promise<ProjectOpenResult> {
  return handlers['project.create']!([
    { at: root, cfg: configFor(root), epoch: 1 },
  ]) as Promise<ProjectOpenResult>
}

let temporaryRoot: string

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.windows.splice(0)
  temporaryRoot = await mkdtemp(join(tmpdir(), 'supraspina-native-ipc-'))
})

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('native host, picker, and web handlers', () => {
  it('reports a stable unavailable host and rejects retry without a supervisor', async () => {
    const handlers = await freshHandlers()

    await expect(handlers['host.getState']!([])).resolves.toMatchObject({
      mode: 'electron',
      platform: expect.stringMatching(/^(?:linux|wsl)$/),
      sidecar: { state: 'unavailable', retryable: true },
    })
    await expect(handlers['host.retrySidecar']!([])).rejects.toThrow(
      /Make the scientific runtime available/,
    )
  })

  it('uses the supervisor for host state and retry when one is present', async () => {
    const retry = vi.fn(async () => undefined)
    const state = {
      state: 'ready',
      generation: 2,
      productVersion: APP_VERSION,
      protocolVersion: '1',
      persistenceVersions: { project: 1, runState: 1, manifest: 1, receipt: 1 },
      capabilities: [],
      runtimeId: 'runtime-2',
      projectAttached: false,
      retryable: false,
      detail: null,
    }
    const handlers = await freshHandlers({
      sidecar: { retry, getState: () => state },
    })

    await expect(handlers['host.getState']!([])).resolves.toMatchObject({
      sidecar: state,
    })
    await handlers['host.retrySidecar']!([])
    expect(retry).toHaveBeenCalledOnce()
  })

  it('handles canceled and selected directory and file pickers', async () => {
    const handlers = await freshHandlers()
    mocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/chosen/dir'] })
      .mockResolvedValueOnce({ canceled: true, filePaths: [] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/chosen/file'] })

    await expect(handlers['fs.chooseDir']!([null])).resolves.toBeNull()
    await expect(
      handlers['fs.chooseDir']!([{ defaultPath: '/start' }]),
    ).resolves.toBe('/chosen/dir')
    await expect(handlers['fs.chooseFile']!([null])).resolves.toBeNull()
    await expect(
      handlers['fs.chooseFile']!([
        { filters: [{ name: 'Text', extensions: ['txt'] }] },
      ]),
    ).resolves.toBe('/chosen/file')

    expect(mocks.showOpenDialog).toHaveBeenNthCalledWith(2, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: '/start',
    })
    expect(mocks.showOpenDialog).toHaveBeenNthCalledWith(4, {
      properties: ['openFile'],
      filters: [{ name: 'Text', extensions: ['txt'] }],
    })
  })

  it('opens only purpose-authorized web destinations and normalizes OS failure', async () => {
    const handlers = await freshHandlers()
    const allowed = {
      url: 'https://github.com/qwareeq8/supraspina/releases',
      purpose: 'releases',
    }

    await expect(handlers['external.openWeb']!([null])).rejects.toThrow(
      /Provide a valid web destination request/,
    )
    await expect(
      handlers['external.openWeb']!([
        { url: 'https://example.test', purpose: 'releases' },
      ]),
    ).rejects.toThrow(/approved web destination/)
    await handlers['external.openWeb']!([allowed])
    expect(mocks.openExternal).toHaveBeenCalledWith(allowed.url)

    mocks.openExternal.mockRejectedValueOnce(new Error('/private/path'))
    await expect(handlers['external.openWeb']!([allowed])).rejects.toThrow(
      /Retry the approved web destination/,
    )
  })

  it('opens only the exact main-owned regular third-party notices file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'supraspina-notices-'))
    const noticesPath = join(directory, 'THIRD_PARTY_NOTICES')
    await writeFile(noticesPath, 'Public notices\n')
    try {
      const handlers = await freshHandlers({
        thirdPartyNoticesPath: noticesPath,
      })
      await expect(
        handlers['external.openThirdPartyNotices']!(['unexpected']),
      ).rejects.toThrow(/Provide valid arguments for third-party notices/)
      await expect(
        handlers['external.openThirdPartyNotices']!([]),
      ).resolves.toBeUndefined()
      expect(mocks.openPath).toHaveBeenCalledWith(noticesPath)

      mocks.openPath.mockResolvedValueOnce('open failed')
      await expect(
        handlers['external.openThirdPartyNotices']!([]),
      ).rejects.toThrow(/Make the third-party notices readable/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns native paths unchanged outside WSL and a real CPU count', async () => {
    const handlers = await freshHandlers()
    await expect(handlers['platform.detect']!([])).resolves.toMatch(
      /^(?:linux|wsl)$/,
    )
    await expect(handlers['platform.cpuCount']!([])).resolves.toSatisfy(
      (value: unknown) =>
        value === null || (typeof value === 'number' && value > 0),
    )
    await expect(
      handlers['platform.toNative']!(['/data/project']),
    ).resolves.toBe('/data/project')
    await expect(
      handlers['platform.fromNative']!(['/data/project']),
    ).resolves.toBe('/data/project')
  })
})

describe('native lifecycle, window, update, and destination handlers', () => {
  it('keeps all window operations benign without a window', async () => {
    const handlers = await freshHandlers()

    await expect(handlers['window.minimize']!([])).resolves.toBeUndefined()
    await expect(
      handlers['window.toggleMaximize']!([]),
    ).resolves.toBeUndefined()
    await expect(handlers['window.isMaximized']!([])).resolves.toBe(false)
    await expect(handlers['window.close']!([])).rejects.toThrow(
      /Make the lifecycle coordinator available/,
    )
  })

  it('minimizes, maximizes, and restores the owning application window', async () => {
    const window = {
      webContents: { id: 7 },
      minimize: vi.fn(),
      isMaximized: vi
        .fn()
        .mockReturnValue(true)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
    }
    mocks.windows.push(window)
    const handlers = await freshHandlers()

    await handlers['window.minimize']!([], { senderId: 7 })
    await handlers['window.toggleMaximize']!([], { senderId: 7 })
    await handlers['window.toggleMaximize']!([], { senderId: 7 })
    await expect(
      handlers['window.isMaximized']!([], { senderId: 7 }),
    ).resolves.toBe(true)
    expect(window.minimize).toHaveBeenCalledOnce()
    expect(window.maximize).toHaveBeenCalledOnce()
    expect(window.unmaximize).toHaveBeenCalledOnce()
  })

  it('acts on the sending window rather than the first application window', async () => {
    const makeWindow = (id: number, maximized: boolean) => ({
      webContents: { id },
      minimize: vi.fn(),
      isMaximized: vi.fn().mockReturnValue(maximized),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
    })
    const first = makeWindow(11, false)
    const sender = makeWindow(22, true)
    mocks.windows.push(first, sender)
    const handlers = await freshHandlers()

    await handlers['window.minimize']!([], { senderId: 22 })
    await handlers['window.toggleMaximize']!([], { senderId: 22 })
    await expect(
      handlers['window.isMaximized']!([], { senderId: 22 }),
    ).resolves.toBe(true)
    expect(sender.minimize).toHaveBeenCalledOnce()
    expect(sender.unmaximize).toHaveBeenCalledOnce()
    expect(first.minimize).not.toHaveBeenCalled()
    expect(first.maximize).not.toHaveBeenCalled()
    expect(first.unmaximize).not.toHaveBeenCalled()
  })

  it('validates lifecycle responses and forwards optional reasons', async () => {
    const request = vi.fn(async () => undefined)
    const respond = vi.fn(async () => undefined)
    const handlers = await freshHandlers({ lifecycle: { request, respond } })

    await expect(
      handlers['lifecycle.respondBoundary']!([null]),
    ).rejects.toThrow(/valid boundary response/)
    await expect(
      handlers['lifecycle.respondBoundary']!([
        { requestId: 'r-1', decision: 'maybe' },
      ]),
    ).rejects.toThrow(/valid boundary decision/)
    await handlers['lifecycle.respondBoundary']!([
      { requestId: 'r-1', decision: 'cancel' },
    ])
    await handlers['lifecycle.respondBoundary']!([
      { requestId: 'r-2', decision: 'proceed', reason: 'saved' },
    ])
    await handlers['window.close']!([])

    expect(respond).toHaveBeenNthCalledWith(1, {
      requestId: 'r-1',
      decision: 'cancel',
    })
    expect(respond).toHaveBeenNthCalledWith(2, {
      requestId: 'r-2',
      decision: 'proceed',
      reason: 'saved',
    })
    expect(request).toHaveBeenCalledWith('window-close')
  })

  it('delegates check/download/status and routes install through lifecycle', async () => {
    const request = vi.fn(async () => undefined)
    const handlers = await freshHandlers({
      lifecycle: { request, respond: vi.fn(async () => undefined) },
    })

    await expect(handlers['update.check']!([])).resolves.toMatchObject({
      available: false,
    })
    await expect(handlers['update.download']!([])).resolves.toBeUndefined()
    await expect(handlers['update.getStatus']!([])).resolves.toMatchObject({
      capability: 'disabled',
    })
    await handlers['update.installNow']!([])

    expect(mocks.updateCheck).toHaveBeenCalledOnce()
    expect(mocks.updateDownload).toHaveBeenCalledOnce()
    expect(mocks.updateStatus).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('update-install')
  })

  it('validates and delegates machine preferences and window placement', async () => {
    const preferenceState = {
      preferences: { schemaVersion: 1, theme: 'system' },
      resolvedTheme: 'dark',
    }
    const placementState = {
      preference: { mode: 'remember' },
      displays: [],
      resolvedDisplayId: 'display-000000000000000000000000',
      fallbackReason: null,
    }
    const preferences = {
      getState: vi.fn(() => preferenceState),
      patch: vi.fn(() => preferenceState),
      reset: vi.fn(() => preferenceState),
    }
    const windowPlacement = {
      getState: vi.fn(() => placementState),
      setPreference: vi.fn(() => placementState),
      moveNow: vi.fn(() => placementState),
      identifyDisplays: vi.fn(),
      resetPreference: vi.fn(() => placementState),
    }
    const handlers = await freshHandlers({ preferences, windowPlacement })

    await expect(handlers['preferences.get']!([])).resolves.toBe(
      preferenceState,
    )
    await expect(
      handlers['preferences.patch']!([{ theme: 'dark' }]),
    ).resolves.toBe(preferenceState)
    await expect(handlers['preferences.patch']!([])).rejects.toThrow(
      /Provide valid arguments for preferences\.patch/,
    )
    await expect(handlers['preferences.reset']!([])).resolves.toBe(
      preferenceState,
    )
    expect(windowPlacement.resetPreference).toHaveBeenCalledOnce()

    await expect(
      handlers['windowPlacement.setPreference']!([{ mode: 'primary' }]),
    ).resolves.toBe(placementState)
    await expect(
      handlers['windowPlacement.setPreference']!([
        { mode: 'display', displayId: 'native-id' },
      ]),
    ).rejects.toThrow(/valid window placement preference/)
    await expect(handlers['windowPlacement.moveNow']!([])).resolves.toBe(
      placementState,
    )
    await handlers['windowPlacement.identifyDisplays']!([])
    expect(windowPlacement.identifyDisplays).toHaveBeenCalledOnce()
  })

  it('validates save purpose and handles canceled and selected destinations', async () => {
    const handlers = await freshHandlers()
    const opened = await createProject(handlers, join(temporaryRoot, 'project'))

    await expect(
      handlers['fs.chooseSavePath']!([
        { project: opened.project, purpose: 'arbitrary' },
      ]),
    ).rejects.toThrow(/valid save destination purpose/)

    mocks.showSaveDialog
      .mockResolvedValueOnce({ canceled: true })
      .mockResolvedValueOnce({
        canceled: false,
        filePath: join(temporaryRoot, 'debug.zip'),
      })
    await expect(
      handlers['fs.chooseSavePath']!([
        { project: opened.project, purpose: 'debug-bundle' },
      ]),
    ).resolves.toBeNull()
    await expect(
      handlers['fs.chooseSavePath']!([
        {
          project: opened.project,
          purpose: 'debug-bundle',
          defaultPath: 'debug.zip',
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        },
      ]),
    ).resolves.toMatchObject({
      destinationId: expect.any(String),
      displayPath: join(temporaryRoot, 'debug.zip'),
    })
  })

  it('accepts the registry example purpose for save destinations', async () => {
    const handlers = await freshHandlers()
    const opened = await createProject(handlers, join(temporaryRoot, 'project'))
    mocks.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: join(temporaryRoot, 'registry-import-example.csv'),
    })
    await expect(
      handlers['fs.chooseSavePath']!([
        { project: opened.project, purpose: 'registry-import-example' },
      ]),
    ).resolves.toMatchObject({
      destinationId: expect.any(String),
      displayPath: join(temporaryRoot, 'registry-import-example.csv'),
    })
  })

  it('gates the registry import read behind the native dialog with bounded UTF-8', async () => {
    const handlers = await freshHandlers()
    const opened = await createProject(handlers, join(temporaryRoot, 'project'))

    await expect(handlers['registry.chooseImportCsv']!([null])).rejects.toThrow(
      /valid registry import request/,
    )

    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    })
    await expect(
      handlers['registry.chooseImportCsv']!([{ project: opened.project }]),
    ).resolves.toBeNull()
    expect(mocks.showOpenDialog).toHaveBeenCalledWith({
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })

    const csvPath = join(temporaryRoot, 'cohort.csv')
    await writeFile(
      csvPath,
      'subjectId,age,sex,sourceCohortLabel,ais,tSinceSci\nsub-0001,40,F,CTRL,,\n',
    )
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [csvPath],
    })
    await expect(
      handlers['registry.chooseImportCsv']!([{ project: opened.project }]),
    ).resolves.toMatchObject({
      name: 'cohort.csv',
      displayPath: csvPath,
      text: expect.stringContaining('sub-0001'),
    })

    const oversized = join(temporaryRoot, 'oversized.csv')
    await writeFile(oversized, 'a'.repeat(512 * 1024 + 1))
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [oversized],
    })
    await expect(
      handlers['registry.chooseImportCsv']!([{ project: opened.project }]),
    ).rejects.toThrow(/bounded size limit/)

    const binary = join(temporaryRoot, 'binary.csv')
    await writeFile(binary, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [binary],
    })
    await expect(
      handlers['registry.chooseImportCsv']!([{ project: opened.project }]),
    ).rejects.toThrow(/UTF-8/)
  })

  it('rejects malformed project close and validates draft configs without sidecar work', async () => {
    const handlers = await freshHandlers()
    await expect(handlers['project.close']!([null])).rejects.toThrow(
      /valid project\.close request/,
    )
    const validation = (await handlers['project.validate']!([{}])) as {
      errors: string[]
      warnings: string[]
    }
    expect(validation.errors.length).toBeGreaterThan(0)
    expect(validation.warnings).toEqual([])

    const projectRoot = join(temporaryRoot, 'valid-project')
    const opened = await createProject(handlers, projectRoot)
    await handlers['project.close']!([{ project: opened.project }])
    expect(
      await readFile(join(projectRoot, 'supraspina.project.json'), 'utf8'),
    ).toContain('Native handler coverage')
  })
})

describe('group-analysis export and brain viewer handlers', () => {
  const RESULT_ID = 'gar-0123456789abcdef'
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="85mm" height="60mm"></svg>'

  const FIXTURES = join(
    __dirname,
    '../../sidecar/tests/fixtures/group_analysis',
  )
  async function v1Result() {
    const fixture = JSON.parse(
      await readFile(join(FIXTURES, 'spec-v1-example.json'), 'utf8'),
    ) as { spec: unknown; specDigest: string }
    return {
      schema: 'supraspina/group-analysis-result',
      schemaVersion: 1,
      resultId: RESULT_ID,
      specId: null,
      name: 'SCI vs controls',
      spec: fixture.spec,
      specDigest: fixture.specDigest,
      createdAt: '2026-09-30T12:00:00.000Z',
      engine: {
        id: 'ols-freedman-lane-maxt-v1',
        rng: 'numpy-pcg64',
        productVersion: '20261121.1830.0',
        build: null,
      },
      provisional: true,
      stageCurrency: { aggregate: 'current', pybrainage: 'current' },
      inputs: [],
      sample: { groups: [], included: 0, excluded: [] },
      rows: [],
      skipped: [],
      resultSha256: 'a'.repeat(64),
    }
  }

  function exportSidecar(
    result: () => Promise<unknown> = v1Result,
    termRows?: (request: { termId: string; offset: number }) => unknown,
  ) {
    return {
      call: vi.fn(async (method: string, args: unknown[]) => {
        if (method === 'groupAnalysis.pinResult') {
          return { resultId: RESULT_ID, pinned: true }
        }
        if (method === 'groupAnalysis.result') return result()
        if (method === 'groupAnalysis.termRows' && termRows) {
          return termRows(args[0] as { termId: string; offset: number })
        }
        if (method !== 'groupAnalysis.exportData') {
          throw new Error(`Unexpected ${method}`)
        }
        return {
          resultId: RESULT_ID,
          name: 'SCI vs controls',
          provisional: true,
          files: [
            { name: 'results.csv', text: 'measure,d\n' },
            { name: 'spec.json', text: '{}\n' },
          ],
        }
      }),
    }
  }

  it('grants the chosen folder once and writes a new export folder in it', async () => {
    const sidecar = exportSidecar()
    const handlers = await freshHandlers({ sidecar })
    const projectRoot = join(temporaryRoot, 'project')
    const opened = await createProject(handlers, projectRoot)
    const parent = join(temporaryRoot, 'exports-here')
    await mkdir(parent)
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [parent],
    })
    const choose = () =>
      handlers['groupAnalysis.chooseExportFolder']!(
        [{ project: opened.project, defaultName: '2026-09-30-sci-vs-ctrl' }],
        { senderId: 7 },
      ) as Promise<{ destinationId: string; displayPath: string }>
    const destination = await choose()
    expect(destination.displayPath).toBe(parent)
    expect(mocks.showOpenDialog.mock.calls[0]!.at(-1)).toMatchObject({
      defaultPath: join(projectRoot, 'exports', 'analysis'),
    })

    const write = (destinationId: string, senderId = 7) =>
      handlers['groupAnalysis.writeExport']!(
        [
          {
            project: opened.project,
            destinationId,
            resultId: RESULT_ID,
            folderName: '2026-09-30-sci-vs-ctrl',
            subjectCsv: false,
            figures: [{ kind: 'svg', stem: 'forest', svg: SVG, pdf: false }],
          },
        ],
        { senderId },
      )
    // Another window cannot use the grant.
    await expect(write(destination.destinationId, 8)).rejects.toThrow(
      /save destination/,
    )
    await expect(write(destination.destinationId)).resolves.toMatchObject({
      displayPath: join(parent, '2026-09-30-sci-vs-ctrl'),
      folderName: '2026-09-30-sci-vs-ctrl',
      provisional: true,
      files: [
        { name: 'results.csv' },
        { name: 'spec.json' },
        { name: 'forest.svg' },
      ],
    })
    expect(
      await readFile(
        join(parent, '2026-09-30-sci-vs-ctrl', 'forest.svg'),
        'utf8',
      ),
    ).toBe(SVG)
    // Only the export tables and the result header (a v1 result has no
    // terms) are fetched, and the result is pinned after the write;
    // nothing enters the Results inventory.
    expect(sidecar.call.mock.calls.map(([method]) => method)).toEqual([
      'groupAnalysis.exportData',
      'groupAnalysis.result',
      'groupAnalysis.pinResult',
    ])
    expect(sidecar.call).toHaveBeenCalledWith('groupAnalysis.exportData', [
      expect.objectContaining({
        project: opened.project,
        resultId: RESULT_ID,
        subjectCsv: false,
        configRevision: 0,
      }),
    ])
    expect(sidecar.call).toHaveBeenLastCalledWith('groupAnalysis.pinResult', [
      {
        project: opened.project,
        resultId: RESULT_ID,
        cfg: expect.any(Object),
        configRevision: 0,
        configSha256: expect.any(String),
      },
    ])
    // The grant is consumed, and a fresh one never overwrites.
    await expect(write(destination.destinationId)).rejects.toThrow(
      /save destination/,
    )
    const again = await choose()
    await expect(write(again.destinationId)).resolves.toMatchObject({
      displayPath: join(parent, '2026-09-30-sci-vs-ctrl-2'),
      folderName: '2026-09-30-sci-vs-ctrl-2',
    })
    expect(await readdir(join(parent, '2026-09-30-sci-vs-ctrl'))).toHaveLength(
      3,
    )
  })

  it('adds the term, grid, and atlas license tables to a v2 export', async () => {
    const example = JSON.parse(
      await readFile(join(FIXTURES, 'result-v2-example.json'), 'utf8'),
    ) as {
      result: {
        resultId: string
        terms: { termId: string }[]
        rows: { termId: string; measureId: string }[]
      }
    }
    const result = { ...example.result, resultId: RESULT_ID }
    const termIds = result.terms.map((term) => term.termId)
    const rowsOf = (termId: string) =>
      result.rows.map((row) => ({ ...row, termId }))
    // Two pages per term exercise the paging.
    const page = ({ termId, offset }: { termId: string; offset: number }) => {
      const rows = rowsOf(termId)
      const end = offset === 0 ? 2 : rows.length
      return {
        resultId: RESULT_ID,
        termId,
        offset,
        total: rows.length,
        rows: rows.slice(offset, end),
        nextOffset: end < rows.length ? end : null,
      }
    }
    const sidecar = exportSidecar(async () => result, page)
    const handlers = await freshHandlers({ sidecar })
    const opened = await createProject(handlers, join(temporaryRoot, 'project'))
    const parent = join(temporaryRoot, 'exports-here')
    await mkdir(parent)
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [parent],
    })
    const choose = () =>
      handlers['groupAnalysis.chooseExportFolder']!(
        [{ project: opened.project, defaultName: 'battery' }],
        { senderId: 7 },
      ) as Promise<{ destinationId: string }>
    const write = async () =>
      handlers['groupAnalysis.writeExport']!(
        [
          {
            project: opened.project,
            destinationId: (await choose()).destinationId,
            resultId: RESULT_ID,
            folderName: 'battery',
            subjectCsv: false,
            figures: [],
          },
        ],
        { senderId: 7 },
      )
    await expect(write()).resolves.toMatchObject({
      folderName: 'battery',
      files: [
        { name: 'results.csv' },
        { name: 'spec.json' },
        { name: 'terms.csv' },
        { name: 'grid.csv' },
        { name: 'atlas-licenses.csv' },
      ],
    })
    const folder = join(parent, 'battery')
    const lines = async (name: string) =>
      (await readFile(join(folder, name), 'utf8')).trimEnd().split('\n')
    expect(await lines('terms.csv')).toHaveLength(1 + termIds.length)
    const grid = await lines('grid.csv')
    expect(grid[0]!.split(',')).toHaveLength(1 + 6 * termIds.length)
    expect(grid.slice(1).map((line) => line.split(',')[0])).toEqual(
      result.rows.map((row) => row.measureId),
    )
    // The atlas catalog was not readable here, so FreeSurfer's license
    // stands for the aseg measures.
    expect(await lines('atlas-licenses.csv')).toEqual([
      'atlas_id,atlas,origin,source,cached_version,license,license_url,license_acknowledged_at,citation',
      'aseg,Subcortical segmentation (aseg),pipeline,FreeSurfer,,FreeSurfer license,https://surfer.nmr.mgh.harvard.edu/fswiki/FreeSurferSoftwareLicense,,See the FreeSurfer documentation for the papers to cite.',
    ])
    const methods = sidecar.call.mock.calls.map(([method]) => method)
    expect(methods.filter((m) => m === 'groupAnalysis.termRows')).toHaveLength(
      2 * termIds.length,
    )
    expect(methods).toContain('groupAnalysis.atlases')

    // A page of another result fails the export before any folder exists.
    const wrong = exportSidecar(
      async () => result,
      (request) => ({ ...page(request), resultId: 'gar-ffffffffffffffff' }),
    )
    const refused = await freshHandlers({ sidecar: wrong })
    const reopened = await createProject(
      refused,
      join(temporaryRoot, 'project-2'),
    )
    const destination = (await refused['groupAnalysis.chooseExportFolder']!(
      [{ project: reopened.project, defaultName: 'wrong' }],
      { senderId: 7 },
    )) as { destinationId: string }
    await expect(
      refused['groupAnalysis.writeExport']!(
        [
          {
            project: reopened.project,
            destinationId: destination.destinationId,
            resultId: RESULT_ID,
            folderName: 'wrong',
            subjectCsv: false,
            figures: [],
          },
        ],
        { senderId: 7 },
      ),
    ).rejects.toThrow(/wrong term rows/)
    expect(await readdir(parent)).toEqual(['battery'])
  })

  it('refuses export folders inside the pipeline outputs and derivatives', async () => {
    const handlers = await freshHandlers({ sidecar: exportSidecar() })
    const projectRoot = join(temporaryRoot, 'project')
    const opened = await createProject(handlers, projectRoot)
    for (const parent of [
      join(projectRoot, 'outputs', 'run', 'qc_review'),
      join(projectRoot, 'derivatives', 'freesurfer'),
    ]) {
      await mkdir(parent, { recursive: true })
      mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: [parent],
      })
      await expect(
        handlers['groupAnalysis.chooseExportFolder']!(
          [{ project: opened.project, defaultName: 'x' }],
          { senderId: 7 },
        ),
      ).rejects.toThrow(/outside the pipeline output and derivatives/)
      expect(await readdir(parent)).toEqual([])
    }
  })

  it('reads the set CSV through the dialog with bounded UTF-8', async () => {
    const handlers = await freshHandlers()
    const opened = await createProject(handlers, join(temporaryRoot, 'project'))
    const choose = () =>
      handlers['groupAnalysis.chooseSetCsv']!([{ project: opened.project }])
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    })
    await expect(choose()).resolves.toBeNull()
    const csv = join(temporaryRoot, 'set.csv')
    await writeFile(csv, 'measure\naseg:Brain-Stem\n')
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [csv],
    })
    await expect(choose()).resolves.toEqual({
      name: 'set.csv',
      displayPath: csv,
      text: 'measure\naseg:Brain-Stem\n',
    })
    await writeFile(csv, 'a'.repeat(256 * 1024 + 1))
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [csv],
    })
    await expect(choose()).rejects.toThrow(/bounded size limit/)
    await expect(
      handlers['groupAnalysis.chooseSetCsv']!([
        { project: opened.project, path: csv },
      ]),
    ).rejects.toThrow(/invalid fields/)
  })

  it('confines brain assets to the FreeSurfer home and the project derivatives', async () => {
    const home = join(temporaryRoot, 'freesurfer')
    const template = join(home, 'subjects', 'fsaverage', 'mri')
    await mkdir(template, { recursive: true })
    await writeFile(join(template, 'brain.mgz'), 'template brain')
    vi.stubEnv('FREESURFER_HOME', home)
    try {
      const handlers = await freshHandlers()
      const projectRoot = join(temporaryRoot, 'project')
      const opened = await createProject(handlers, projectRoot)
      const subjects = join(projectRoot, 'derivatives', 'freesurfer')
      await mkdir(join(subjects, 'sub-01', 'mri'), { recursive: true })
      await writeFile(join(subjects, 'sub-01', 'mri', 'brain.mgz'), 'sub brain')
      // FreeSurfer's recon-all links fsaverage into the subjects folder.
      await symlink(
        join(home, 'subjects', 'fsaverage'),
        join(subjects, 'fsaverage'),
      )
      // A subject folder whose mri/ links outside the project.
      const outside = join(temporaryRoot, 'outside', 'mri')
      await mkdir(outside, { recursive: true })
      await writeFile(join(outside, 'brain.mgz'), 'outside brain')
      await mkdir(join(subjects, 'sub-02'))
      await symlink(outside, join(subjects, 'sub-02', 'mri'))

      const read = (request: Record<string, unknown>) =>
        handlers['brainViewer.readAsset']!([
          { project: opened.project, ...request },
        ]) as Promise<{ data: Uint8Array; sha256: string }>
      const fsaverage = await read({ assetId: 'fsaverage/mri/brain.mgz' })
      expect(Buffer.from(fsaverage.data).toString()).toBe('template brain')
      const subject = await read({
        assetId: 'subject/mri/brain.mgz',
        subjectId: 'sub-01',
      })
      expect(Buffer.from(subject.data).toString()).toBe('sub brain')
      await expect(
        read({ assetId: 'subject/mri/brain.mgz', subjectId: 'fsaverage' }),
      ).rejects.toThrow(/valid subject ID/)
      await expect(
        read({ assetId: 'subject/mri/brain.mgz', subjectId: 'sub-02' }),
      ).rejects.toThrow(/real path within active project output roots/)
      await expect(
        read({ assetId: 'subject/mri/brain.mgz', subjectId: '..' }),
      ).rejects.toThrow(/valid subject ID/)
      await expect(
        read({ assetId: 'fsaverage/mri/brain.mgz', extra: true }),
      ).rejects.toThrow(/invalid fields/)

      const report = (await handlers['brainViewer.assets']!([
        { project: opened.project, subjectId: 'sub-02' },
      ])) as { available: boolean; assets: { assetId: string }[] }
      // Only fsaverage's brain.mgz exists in this home, and sub-02 escapes.
      expect(report.available).toBe(false)
      expect(report.assets.map((asset) => asset.assetId)).toEqual([
        'fsaverage/mri/brain.mgz',
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
