import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type {
  GroupAnalysisExportData,
  GroupAnalysisExportRequest,
  GroupAnalysisRowV2,
  GroupAnalysisSpecV2,
  GroupAnalysisTerm,
} from '../shared/group-analysis'
import type { AnalysisExportTerms } from './group-analysis-export'

const mocks = vi.hoisted(() => {
  type Listener = (event: { preventDefault: () => void }) => void
  const windows: FakeWindow[] = []
  interface FakeWindow {
    options: Record<string, unknown>
    destroyed: boolean
    loadURL: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    isDestroyed: () => boolean
    listeners: Map<string, Listener>
    webContents: {
      setWindowOpenHandler: ReturnType<typeof vi.fn>
      on: (name: string, listener: Listener) => void
      printToPDF: ReturnType<typeof vi.fn>
    }
  }
  const fakeSession = {
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
  }
  return {
    windows,
    fakeSession,
    fromPartition: vi.fn(() => fakeSession),
    showOpenDialog: vi.fn(),
    loadURL: vi.fn(async (url: string): Promise<void> => {
      void url
    }),
    printToPDF: vi.fn(async (options?: unknown) => {
      void options
      return Buffer.from('%PDF-1.4 fake')
    }),
    linkFailure: null as string | null,
  }
})

vi.mock('electron', () => {
  class BrowserWindow {
    options: Record<string, unknown>
    destroyed = false
    listeners = new Map<
      string,
      (event: { preventDefault: () => void }) => void
    >()
    loadURL = vi.fn((url: string) => mocks.loadURL(url))
    destroy = vi.fn(() => {
      this.destroyed = true
    })
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: (
        name: string,
        listener: (event: { preventDefault: () => void }) => void,
      ) => {
        this.listeners.set(name, listener)
      },
      printToPDF: vi.fn((options: unknown) => mocks.printToPDF(options)),
    }
    constructor(options: Record<string, unknown>) {
      this.options = options
      mocks.windows.push(this as never)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
  }
  return {
    BrowserWindow,
    dialog: { showOpenDialog: mocks.showOpenDialog },
    session: { fromPartition: mocks.fromPartition },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const link = vi.fn(async (from: string, to: string) => {
    if (mocks.linkFailure !== null) {
      const code = mocks.linkFailure
      throw Object.assign(new Error(code), { code })
    }
    return actual.link(from, to)
  })
  return { ...actual, default: { ...actual, link }, link }
})

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0,
  0,
])
const SVG =
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="85mm" height="60mm" viewBox="0 0 85 60"><text>Brainstem</text></svg>'
const RESULT_ID = 'gar-0123456789abcdef'
const pinned: string[] = []
const pinResult = vi.fn(async (resultId: string) => {
  pinned.push(resultId)
})

let root: string

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  mocks.windows.splice(0)
  mocks.linkFailure = null
  pinned.splice(0)
  mocks.loadURL.mockImplementation(async () => undefined)
  mocks.printToPDF.mockImplementation(async () => Buffer.from('%PDF-1.4 fake'))
  root = await mkdtemp(join(tmpdir(), 'supraspina-analysis-export-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

async function load() {
  return import('./group-analysis-export')
}

function exportData(
  overrides: Partial<GroupAnalysisExportData> = {},
  subjectCsv = false,
): GroupAnalysisExportData {
  return {
    resultId: RESULT_ID,
    name: 'SCI vs controls',
    provisional: false,
    files: [
      {
        name: 'spec.json',
        text: '{"schema":"supraspina/group-analysis-spec"}\n',
      },
      ...(subjectCsv
        ? [{ name: 'subjects.csv' as const, text: 'subject,value\n' }]
        : []),
      { name: 'results.csv', text: 'measure,d\naseg:Brain-Stem,-0.48\n' },
    ],
    ...overrides,
  }
}

function request(
  overrides: Partial<GroupAnalysisExportRequest> = {},
): GroupAnalysisExportRequest {
  return {
    destinationId: 'destination',
    resultId: RESULT_ID,
    folderName: '2026-09-30-sci-vs-ctrl',
    subjectCsv: false,
    figures: [],
    ...overrides,
  }
}

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('export request parsing', () => {
  const base = {
    destinationId: 'destination',
    resultId: RESULT_ID,
    folderName: '2026-09-30-sci-vs-ctrl',
    subjectCsv: false,
    figures: [] as unknown[],
  }

  it('accepts SVG and PNG figures with allowlisted names', async () => {
    const { parseAnalysisExportRequest } = await load()
    const parsed = parseAnalysisExportRequest({
      ...base,
      figures: [
        { kind: 'svg', stem: 'forest', svg: SVG, pdf: true },
        { kind: 'png', stem: 'forest', png: PNG },
      ],
    })
    expect(parsed.figures.map((f) => `${f.kind}:${f.stem}`)).toEqual([
      'svg:forest',
      'png:forest',
    ])
  })

  it.each(['../x', 'A', '.hidden', 'a/b', 'a b', '', 'x'.repeat(129)])(
    'refuses the folder name %j',
    async (folderName) => {
      const { parseAnalysisExportRequest } = await load()
      expect(() => parseAnalysisExportRequest({ ...base, folderName })).toThrow(
        /\[a-z0-9._-\]/,
      )
    },
  )

  it('refuses unsafe stems, extra keys, duplicates, and too many figures', async () => {
    const { parseAnalysisExportRequest, MAX_EXPORT_FIGURES } = await load()
    const figure = (stem: string) => ({ kind: 'png', stem, png: PNG })
    expect(() =>
      parseAnalysisExportRequest({ ...base, figures: [figure('../f')] }),
    ).toThrow(/Name each figure/)
    expect(() =>
      parseAnalysisExportRequest({ ...base, figures: [figure('F.png')] }),
    ).toThrow(/Name each figure/)
    expect(() => parseAnalysisExportRequest({ ...base, extra: 1 })).toThrow(
      /invalid fields/,
    )
    expect(() =>
      parseAnalysisExportRequest({
        ...base,
        figures: [figure('a'), figure('a')],
      }),
    ).toThrow(/different name/)
    expect(() =>
      parseAnalysisExportRequest({
        ...base,
        figures: Array.from({ length: MAX_EXPORT_FIGURES + 1 }, (_, i) =>
          figure(`f${i}`),
        ),
      }),
    ).toThrow(/at most/)
    expect(() =>
      parseAnalysisExportRequest({
        ...base,
        figures: [{ kind: 'pdf', stem: 'a', pdf: new Uint8Array(4) }],
      }),
    ).toThrow(/SVG or PNG/)
  })

  it('refuses content that is not an SVG or PNG of the named kind', async () => {
    const { parseAnalysisExportRequest } = await load()
    const svg = (text: string, pdf = false) => ({
      ...base,
      figures: [{ kind: 'svg', stem: 'f', svg: text, pdf }],
    })
    expect(() => parseAnalysisExportRequest(svg('<html></html>'))).toThrow(
      /valid SVG/,
    )
    expect(() =>
      parseAnalysisExportRequest(
        svg('<!DOCTYPE svg [<!ENTITY a "aa">]><svg>&a;</svg>'),
      ),
    ).toThrow(/valid SVG/)
    expect(() =>
      parseAnalysisExportRequest(svg('<svg width="1mm">\0</svg>')),
    ).toThrow(/valid SVG/)
    // A PDF needs a physical size.
    expect(() => parseAnalysisExportRequest(svg('<svg></svg>', true))).toThrow(
      /between 1 and 1000 mm/,
    )
    const notPng = Uint8Array.from(PNG)
    notPng[1] = 0
    expect(() =>
      parseAnalysisExportRequest({
        ...base,
        figures: [{ kind: 'png', stem: 'f', png: notPng }],
      }),
    ).toThrow(/valid PNG/)
    expect(() =>
      parseAnalysisExportRequest({
        ...base,
        figures: [{ kind: 'png', stem: 'f', png: Array.from(PNG) }],
      }),
    ).toThrow(/valid PNG/)
  })

  it('checks a pathological SVG prologue in linear time', async () => {
    const { parseAnalysisExportRequest, svgFigureSize } = await load()
    const svg = (text: string) => ({
      ...base,
      figures: [{ kind: 'svg', stem: 'f', svg: text, pdf: false }],
    })
    // Each empty comment would double a lazy-group regex's backtracking.
    const started = performance.now()
    expect(() =>
      parseAnalysisExportRequest(svg(`${'<!---->'.repeat(26)}x`)),
    ).toThrow(/valid SVG/)
    expect(performance.now() - started).toBeLessThan(250)
    expect(() =>
      parseAnalysisExportRequest(svg(`${'<!---->'.repeat(200_000)}x`)),
    ).toThrow(/valid SVG/)
    expect(() =>
      parseAnalysisExportRequest(svg(`<?xml${'<!--'.repeat(100_000)}`)),
    ).toThrow(/valid SVG/)
    expect(() => svgFigureSize(`<svg ${'<svg'.repeat(300_000)}`)).toThrow(
      /between 1 and 1000 mm/,
    )
    expect(performance.now() - started).toBeLessThan(1000)
    expect(
      parseAnalysisExportRequest(
        svg(
          `\uFEFF <?xml version="1.0"?>\n<!-- a --> <!---->\n${SVG.slice(21)}`,
        ),
      ).figures,
    ).toHaveLength(1)
  })

  it.each([
    '<script>alert(1)</script>',
    '<svg:script href="#a"/>',
    '<foreignObject><div>x</div></foreignObject>',
    '<image href="file:///etc/passwd"/>',
    "<use xlink:href = 'https://example.com/a.svg#x'/>",
    '<image href=http://127.0.0.1/x.png />',
    '<rect style="fill: url( \'https://example.com/p.svg#g\')"/>',
    '<style>@import "https://example.com/a.css";</style>',
    '<style>@font-face{src:url(/fonts/a.woff2)}</style>',
  ])('refuses the active or external SVG content %j', async (content) => {
    const { parseAnalysisExportRequest } = await load()
    expect(() =>
      parseAnalysisExportRequest({
        ...base,
        figures: [
          {
            kind: 'svg',
            stem: 'f',
            svg: SVG.replace('<text>', `${content}<text>`),
            pdf: false,
          },
        ],
      }),
    ).toThrow(/valid SVG/)
  })

  it('accepts fragment references and inline data', async () => {
    const { parseAnalysisExportRequest, svgIsInert } = await load()
    const content =
      '<defs><clipPath id="c"><rect/></clipPath></defs>' +
      '<use href="#c"/><use xlink:href=\'#c\'/>' +
      '<rect clip-path="url(#c)" fill="url( \'#g\' )"/>' +
      '<style>@font-face{src:url(data:font/woff2;base64,AAAA)}</style>' +
      '<image href="data:image/png;base64,AAAA"/>'
    const svg = SVG.replace('<text>', `${content}<text>`)
    expect(
      parseAnalysisExportRequest({
        ...base,
        figures: [{ kind: 'svg', stem: 'f', svg, pdf: false }],
      }).figures,
    ).toHaveLength(1)
    // Bounded matches keep the scan linear on an unterminated flood.
    const started = performance.now()
    expect(svgIsInert(`<svg>${'url(url('.repeat(200_000)}`)).toBe(false)
    expect(svgIsInert(`<svg>${'<a:'.repeat(300_000)}`)).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('refuses a PDF from an SVG over the data URL budget', async () => {
    const { parseAnalysisExportRequest, MAX_PDF_SVG_BYTES } = await load()
    const big = SVG.replace(
      '<text>',
      `<!--${'x'.repeat(MAX_PDF_SVG_BYTES)}--><text>`,
    )
    expect(() =>
      parseAnalysisExportRequest({
        ...base,
        figures: [{ kind: 'svg', stem: 'f', svg: big, pdf: true }],
      }),
    ).toThrow(/without a PDF/)
    expect(
      parseAnalysisExportRequest({
        ...base,
        figures: [{ kind: 'svg', stem: 'f', svg: big, pdf: false }],
      }).figures,
    ).toHaveLength(1)
  })
})

describe('figure size', () => {
  it('reads physical units and falls back to the viewBox in CSS pixels', async () => {
    const { svgFigureSize } = await load()
    expect(svgFigureSize(SVG)).toEqual({ widthMm: 85, heightMm: 60 })
    expect(svgFigureSize('<svg width="2in" height=\'72pt\'>')).toEqual({
      widthMm: 50.8,
      heightMm: 25.4,
    })
    expect(svgFigureSize('<svg width="11.4cm" height="96">')).toEqual({
      widthMm: 114,
      heightMm: 25.4,
    })
    expect(svgFigureSize('<svg viewBox="0 0 96 192">')).toEqual({
      widthMm: 25.4,
      heightMm: 50.8,
    })
    expect(() => svgFigureSize('<svg width="100%" height="1mm">')).toThrow(
      /between 1 and 1000 mm/,
    )
    expect(() => svgFigureSize('<svg width="2000mm" height="10mm">')).toThrow(
      /between 1 and 1000 mm/,
    )
  })
})

describe('bounded request measure', () => {
  it('counts bytes structurally and stops past the limit', async () => {
    const { boundedRequestBytes } = await load()
    const png = new Uint8Array(1000)
    expect(boundedRequestBytes({ a: 'xy', b: [1, true, null], png }, 1e6)).toBe(
      2 + 4 + 4 + 4 + 2 + 24 + 6 + 1000,
    )
    expect(boundedRequestBytes({ png: new Uint8Array(2048) }, 1024)).toBe(1025)
    // A view counts its whole backing buffer, which IPC would transfer.
    expect(
      boundedRequestBytes(new Uint8Array(new ArrayBuffer(4096), 0, 4), 1e6),
    ).toBe(4096)
  })

  it('refuses non-plain values and deep nesting', async () => {
    const { boundedRequestBytes } = await load()
    expect(() => boundedRequestBytes({ m: new Map() }, 1e6)).toThrow(
      /JSON-serializable/,
    )
    expect(() => boundedRequestBytes({ d: new Date() }, 1e6)).toThrow(
      /JSON-serializable/,
    )
    expect(() => boundedRequestBytes(new Float64Array(2), 1e6)).toThrow(
      /JSON-serializable/,
    )
    let deep: unknown = 'leaf'
    for (let i = 0; i < 12; i++) deep = [deep]
    expect(() => boundedRequestBytes(deep, 1e6)).toThrow(/shallower/)
  })
})

describe('choosing the export folder', () => {
  it('opens at the project exports folder and registers the choice', async () => {
    const { chooseAnalysisExportFolder } = await load()
    const chosen = join(root, 'elsewhere')
    await mkdir(chosen)
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [chosen],
    })
    const register = vi.fn((path: string) => ({
      destinationId: 'd1',
      displayPath: path,
    }))
    const window = { id: 1 }
    await expect(
      chooseAnalysisExportFolder({
        projectRoot: root,
        forbiddenRoots: [],
        defaultName: '2026-09-30-sci-vs-ctrl',
        window: window as never,
        register,
      }),
    ).resolves.toEqual({ destinationId: 'd1', displayPath: chosen })
    expect(register).toHaveBeenCalledWith(chosen)
    const [owner, options] = mocks.showOpenDialog.mock.calls[0]!
    expect(owner).toBe(window)
    expect(options).toMatchObject({
      defaultPath: join(root, 'exports', 'analysis'),
      properties: expect.arrayContaining(['openDirectory', 'createDirectory']),
    })
    expect(options.message).toContain('2026-09-30-sci-vs-ctrl')
    expect(
      (
        await readdir(join(root, 'exports'), { withFileTypes: true })
      )[0]!.isDirectory(),
    ).toBe(true)
  })

  it('returns null on cancel and refuses files and links', async () => {
    const { chooseAnalysisExportFolder } = await load()
    const register = vi.fn()
    const context = {
      projectRoot: root,
      forbiddenRoots: [],
      defaultName: 'x',
      window: null,
      register,
    }
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    })
    await expect(chooseAnalysisExportFolder(context)).resolves.toBeNull()
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [file],
    })
    await expect(chooseAnalysisExportFolder(context)).rejects.toThrow(
      /existing folder/,
    )
    const linked = join(root, 'linked')
    await symlink(tmpdir(), linked)
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [linked],
    })
    await expect(chooseAnalysisExportFolder(context)).rejects.toThrow(
      /not a file or a link/,
    )
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['relative/path'],
    })
    await expect(chooseAnalysisExportFolder(context)).rejects.toThrow(
      /valid export folder/,
    )
    expect(register).not.toHaveBeenCalled()
    // Without an owner window the dialog is application-modal.
    expect(mocks.showOpenDialog.mock.calls[0]).toHaveLength(1)
  })
})

describe('writing an export', () => {
  it('writes the tables and figures with digests in a new folder', async () => {
    const { writeAnalysisExport } = await load()
    const renderPdf = vi.fn(async () => Buffer.from('%PDF-rendered'))
    const data = exportData({ provisional: true }, true)
    const fetch = vi.fn(async () => data)
    const result = await writeAnalysisExport({
      parent: root,
      forbiddenRoots: [],
      request: request({
        subjectCsv: true,
        figures: [
          { kind: 'svg', stem: 'forest', svg: SVG, pdf: true },
          { kind: 'svg', stem: 'measure', svg: SVG, pdf: false },
          { kind: 'png', stem: 'brain', png: PNG },
        ],
      }),
      exportData: fetch,
      pinResult,
      renderPdf,
    })
    const folder = join(root, '2026-09-30-sci-vs-ctrl')
    expect(fetch).toHaveBeenCalledWith(RESULT_ID, true)
    // Pinned once, after every file was written.
    expect(pinned).toEqual([RESULT_ID])
    expect(renderPdf).toHaveBeenCalledOnce()
    expect(renderPdf).toHaveBeenCalledWith(SVG, { widthMm: 85, heightMm: 60 })
    expect(result.displayPath).toBe(folder)
    expect(result.folderName).toBe('2026-09-30-sci-vs-ctrl')
    expect(result.provisional).toBe(true)
    expect(result.files.map((f) => f.name)).toEqual([
      'results.csv',
      'subjects.csv',
      'spec.json',
      'forest.svg',
      'forest.pdf',
      'measure.svg',
      'brain.png',
    ])
    expect((await readdir(folder)).sort()).toEqual(
      result.files.map((f) => f.name).sort(),
    )
    for (const file of result.files) {
      const bytes = await readFile(join(folder, file.name))
      expect(file.bytes).toBe(bytes.byteLength)
      expect(file.sha256).toBe(sha(bytes))
    }
    expect(await readFile(join(folder, 'forest.svg'), 'utf8')).toBe(SVG)
    expect(await readFile(join(folder, 'forest.pdf'), 'utf8')).toBe(
      '%PDF-rendered',
    )
    expect(new Uint8Array(await readFile(join(folder, 'brain.png')))).toEqual(
      PNG,
    )
    expect(await readFile(join(folder, 'results.csv'), 'utf8')).toBe(
      'measure,d\naseg:Brain-Stem,-0.48\n',
    )
  })

  it('keeps a written export when pinning the result fails', async () => {
    const { writeAnalysisExport } = await load()
    const result = await writeAnalysisExport({
      parent: root,
      forbiddenRoots: [],
      request: request(),
      exportData: async () => exportData(),
      pinResult: async () => {
        throw new Error('The workflow service stopped.')
      },
    })
    expect(result.files.map((f) => f.name)).toEqual([
      'results.csv',
      'spec.json',
    ])
  })

  it('writes the next free suffix and never overwrites an existing folder', async () => {
    const { writeAnalysisExport } = await load()
    const folder = join(root, '2026-09-30-sci-vs-ctrl')
    await mkdir(folder)
    await writeFile(join(folder, 'results.csv'), 'keep me')
    await mkdir(`${folder}-2`)
    const write = () =>
      writeAnalysisExport({
        parent: root,
        forbiddenRoots: [],
        request: request(),
        exportData: async () => exportData(),
        pinResult,
      })
    await expect(write()).resolves.toMatchObject({
      displayPath: `${folder}-3`,
      folderName: '2026-09-30-sci-vs-ctrl-3',
    })
    await expect(write()).resolves.toMatchObject({
      folderName: '2026-09-30-sci-vs-ctrl-4',
    })
    expect(await readdir(folder)).toEqual(['results.csv'])
    expect(await readFile(join(folder, 'results.csv'), 'utf8')).toBe('keep me')
    expect(await readdir(`${folder}-2`)).toEqual([])
    expect((await readdir(`${folder}-3`)).sort()).toEqual([
      'results.csv',
      'spec.json',
    ])
  })

  it('keeps a suffixed name within 128 characters and stops after -100', async () => {
    const { writeAnalysisExport, MAX_EXPORT_FOLDER_TRIES } = await load()
    const long = 'a'.repeat(128)
    await mkdir(join(root, long))
    const write = (folderName: string) =>
      writeAnalysisExport({
        parent: root,
        forbiddenRoots: [],
        request: request({ folderName }),
        exportData: async () => exportData(),
        pinResult,
      })
    await expect(write(long)).resolves.toMatchObject({
      folderName: `${'a'.repeat(126)}-2`,
    })
    await mkdir(join(root, 'full'))
    for (let index = 2; index <= MAX_EXPORT_FOLDER_TRIES; index++) {
      await mkdir(join(root, `full-${index}`))
    }
    await expect(write('full')).rejects.toThrow(
      /Choose another export folder; full and its numbered copies through -100 already exist/,
    )
    expect(await readdir(join(root, 'full-100'))).toEqual([])
  })

  it('refuses mismatched tables before creating anything', async () => {
    const { writeAnalysisExport } = await load()
    const attempt = (
      data: GroupAnalysisExportData,
      subjectCsv = false,
    ): Promise<unknown> =>
      writeAnalysisExport({
        parent: root,
        forbiddenRoots: [],
        request: request({ subjectCsv }),
        exportData: async () => data,
        pinResult,
      })
    await expect(
      attempt(exportData({ resultId: 'gar-ffffffffffffffff' })),
    ).rejects.toThrow(/another result/)
    await expect(attempt(exportData({}, true))).rejects.toThrow(
      /wrong export tables/,
    )
    await expect(attempt(exportData(), true)).rejects.toThrow(
      /wrong export tables/,
    )
    expect(await readdir(root)).toEqual([])
  })

  it('leaves nothing behind when a PDF fails to render', async () => {
    const { writeAnalysisExport } = await load()
    await expect(
      writeAnalysisExport({
        parent: root,
        forbiddenRoots: [],
        request: request({
          figures: [{ kind: 'svg', stem: 'forest', svg: SVG, pdf: true }],
        }),
        exportData: async () => exportData(),
        pinResult,
        renderPdf: async () => {
          throw new Error('Rendering the PDF took over 30 seconds.')
        },
      }),
    ).rejects.toThrow(/30 seconds/)
    expect(await readdir(root)).toEqual([])
    expect(pinResult).not.toHaveBeenCalled()
  })

  it('removes the partial folder when a write fails', async () => {
    const { writeAnalysisExport } = await load()
    mocks.linkFailure = 'EIO'
    await expect(
      writeAnalysisExport({
        parent: root,
        forbiddenRoots: [],
        request: request(),
        exportData: async () => exportData(),
        pinResult,
      }),
    ).rejects.toThrow(/EIO/)
    expect(await readdir(root)).toEqual([])
    expect(pinResult).not.toHaveBeenCalled()
  })

  it('falls back to a checked rename where hard links are unsupported', async () => {
    const { writeAnalysisExport } = await load()
    mocks.linkFailure = 'EPERM'
    const result = await writeAnalysisExport({
      parent: root,
      forbiddenRoots: [],
      request: request(),
      exportData: async () => exportData(),
      pinResult,
    })
    const folder = join(root, '2026-09-30-sci-vs-ctrl')
    // No temporary names remain.
    expect((await readdir(folder)).sort()).toEqual(['results.csv', 'spec.json'])
    expect(result.files.map((f) => f.name)).toEqual([
      'results.csv',
      'spec.json',
    ])
  })

  it('refuses a parent inside the pipeline output or derivatives folders', async () => {
    const {
      writeAnalysisExport,
      chooseAnalysisExportFolder,
      assertExportParentAllowed,
    } = await load()
    const run = join(root, 'outputs', 'run')
    const derivatives = join(root, 'derivatives')
    await mkdir(join(run, 'qc_review'), { recursive: true })
    await mkdir(derivatives)
    await mkdir(join(root, 'exports'))
    const linked = join(root, 'exports', 'into-run')
    await symlink(join(run, 'qc_review'), linked)
    const forbiddenRoots = [run, derivatives]
    const fetch = vi.fn(async () => exportData())
    for (const parent of [run, join(run, 'qc_review'), derivatives]) {
      await expect(
        writeAnalysisExport({
          parent,
          forbiddenRoots,
          request: request(),
          exportData: fetch,
          pinResult,
        }),
      ).rejects.toThrow(/outside the pipeline output and derivatives/)
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(await readdir(join(run, 'qc_review'))).toEqual([])
    // Links are compared by their real paths, on either side.
    await expect(assertExportParentAllowed(linked, [run])).rejects.toThrow(
      /outside the pipeline/,
    )
    const runLink = join(root, 'run-link')
    await symlink(run, runLink)
    await expect(
      assertExportParentAllowed(join(run, 'qc_review'), [runLink]),
    ).rejects.toThrow(/outside the pipeline/)
    // A sibling whose name merely starts like the root is allowed.
    const sibling = join(root, 'outputs', 'run-exports')
    await mkdir(sibling)
    await expect(
      writeAnalysisExport({
        parent: sibling,
        forbiddenRoots,
        request: request(),
        exportData: fetch,
        pinResult,
      }),
    ).resolves.toMatchObject({ provisional: false })
    mocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [derivatives],
    })
    const register = vi.fn()
    await expect(
      chooseAnalysisExportFolder({
        projectRoot: root,
        defaultName: 'x',
        window: null,
        forbiddenRoots,
        register,
      }),
    ).rejects.toThrow(/outside the pipeline output and derivatives/)
    expect(register).not.toHaveBeenCalled()
  })

  it('refuses a parent that is not a folder', async () => {
    const { writeAnalysisExport } = await load()
    await expect(
      writeAnalysisExport({
        parent: join(root, 'missing'),
        forbiddenRoots: [],
        request: request(),
        exportData: async () => exportData(),
        pinResult,
      }),
    ).rejects.toThrow(/export folder again/)
  })
})

describe('PDF rendering window', () => {
  it('renders in a hidden, sandboxed, script-free window that is destroyed', async () => {
    const { renderSvgToPdf, ANALYSIS_PDF_PARTITION } = await load()
    const pdf = await renderSvgToPdf(SVG, { widthMm: 85, heightMm: 60 })
    expect(Buffer.from(pdf).toString()).toBe('%PDF-1.4 fake')
    expect(mocks.fromPartition).toHaveBeenCalledWith(ANALYSIS_PDF_PARTITION, {
      cache: false,
    })
    expect(ANALYSIS_PDF_PARTITION).not.toMatch(/^persist:/)
    const [win] = mocks.windows
    expect(win!.options).toMatchObject({
      show: false,
      webPreferences: {
        session: mocks.fakeSession,
        sandbox: true,
        javascript: false,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const prefs = win!.options.webPreferences as Record<string, unknown>
    expect(prefs).not.toHaveProperty('preload')
    const [url] = win!.loadURL.mock.calls[0]!
    expect(url).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(
      Buffer.from(String(url).split(',')[1]!, 'base64').toString('utf8'),
    ).toBe(SVG)
    expect(mocks.printToPDF).toHaveBeenCalledWith(
      expect.objectContaining({
        pageSize: { width: 85 / 25.4, height: 60 / 25.4 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        printBackground: true,
      }),
    )
    expect(win!.destroy).toHaveBeenCalledOnce()
    expect(win!.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({
      action: 'deny',
    })
    for (const name of [
      'will-navigate',
      'will-redirect',
      'will-attach-webview',
    ]) {
      const preventDefault = vi.fn()
      win!.listeners.get(name)!({ preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
  })

  it('blocks every request but inline data, downloads, and permissions, once per session', async () => {
    const { renderSvgToPdf } = await load()
    const size = { widthMm: 85, heightMm: 60 }
    await renderSvgToPdf(SVG, size)
    await renderSvgToPdf(SVG, size)
    expect(mocks.fakeSession.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
    const filter = mocks.fakeSession.webRequest.onBeforeRequest.mock
      .calls[0]![0] as (
      details: { url: string },
      callback: (response: { cancel: boolean }) => void,
    ) => void
    const decide = (url: string): boolean => {
      let cancel = false
      filter({ url }, (response) => {
        cancel = response.cancel
      })
      return cancel
    }
    expect(decide('https://example.com/font.woff2')).toBe(true)
    expect(decide('file:///etc/passwd')).toBe(true)
    expect(decide('http://127.0.0.1:9/')).toBe(true)
    expect(decide('data:font/woff2;base64,AAAA')).toBe(false)
    const request = mocks.fakeSession.setPermissionRequestHandler.mock
      .calls[0]![0] as (
      a: unknown,
      b: string,
      cb: (ok: boolean) => void,
    ) => void
    const granted = vi.fn()
    request(null, 'media', granted)
    expect(granted).toHaveBeenCalledWith(false)
    const check = mocks.fakeSession.setPermissionCheckHandler.mock
      .calls[0]![0] as () => boolean
    expect(check()).toBe(false)
    expect(mocks.fakeSession.on).toHaveBeenCalledOnce()
    const [event, onDownload] = mocks.fakeSession.on.mock.calls[0]! as [
      string,
      (
        event: { preventDefault: () => void },
        item: { cancel: () => void },
      ) => void,
    ]
    expect(event).toBe('will-download')
    const preventDefault = vi.fn()
    const cancel = vi.fn()
    onDownload({ preventDefault }, { cancel })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('destroys the window when loading fails', async () => {
    const { renderSvgToPdf } = await load()
    mocks.loadURL.mockRejectedValueOnce(new Error('ERR_INVALID_URL'))
    await expect(
      renderSvgToPdf(SVG, { widthMm: 85, heightMm: 60 }),
    ).rejects.toThrow(/ERR_INVALID_URL/)
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
    expect(mocks.printToPDF).not.toHaveBeenCalled()
  })

  it('stops at the timeout and destroys the window', async () => {
    vi.useFakeTimers()
    const { renderSvgToPdf, PDF_RENDER_TIMEOUT_MS } = await load()
    mocks.printToPDF.mockImplementationOnce(() => new Promise(() => undefined))
    const pending = renderSvgToPdf(SVG, { widthMm: 85, heightMm: 60 })
    const settled = expect(pending).rejects.toThrow(/over 30 seconds/)
    await vi.advanceTimersByTimeAsync(PDF_RENDER_TIMEOUT_MS)
    await settled
    expect(mocks.windows[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('refuses an oversized SVG without opening a window', async () => {
    const { renderSvgToPdf, MAX_PDF_SVG_BYTES } = await load()
    await expect(
      renderSvgToPdf('x'.repeat(MAX_PDF_SVG_BYTES + 1), {
        widthMm: 10,
        heightMm: 10,
      }),
    ).rejects.toThrow(/without a PDF/)
    expect(mocks.windows).toHaveLength(0)
  })
})

describe('v2 export tables', () => {
  function term(
    termId: string,
    overrides: Partial<GroupAnalysisTerm> = {},
  ): GroupAnalysisTerm {
    return {
      termId,
      testId: 'test-1',
      kind: 't',
      rank: 1,
      role: 'effect',
      label: `Term ${termId}`,
      family: 'aseg',
      stratum: null,
      pair: null,
      rowCount: 2,
      ...overrides,
    }
  }

  function row(
    termId: string,
    measureId: string,
    overrides: Partial<GroupAnalysisRowV2> = {},
  ): GroupAnalysisRowV2 {
    return {
      termId,
      measureId,
      family: 'aseg',
      nTotal: 82,
      nFocal: 34,
      nReference: 48,
      estimate: -1,
      se: 0.5,
      t: -2,
      F: null,
      df1: 1,
      df2: 77,
      p: 0.04,
      pCorrected: 0.08,
      significant: false,
      d: null,
      dLow: null,
      dHigh: null,
      dRawSd: null,
      partialEta2: 0.04,
      partialR: -0.2,
      partialRLow: -0.4,
      partialRHigh: 0.01,
      slopePerSd: null,
      pctOfReference: null,
      pHc3: null,
      pPermutation: null,
      gated: false,
      inFamily: true,
      ...overrides,
    }
  }

  function data(): AnalysisExportTerms {
    const spec = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../sidecar/tests/fixtures/group_analysis/spec-v2-within-battery.json',
        ),
        'utf8',
      ),
    ).spec as GroupAnalysisSpecV2
    return {
      spec: { ...spec, measures: ['aseg:Brain-Stem', 'aseg:bi:Thalamus'] },
      terms: [
        term('term-1', { pair: { focal: 'AIS A', reference: 'AIS B-D' } }),
        term('term-2', { kind: 'F', rank: 2, label: '=Omnibus, "all"' }),
        term('term-3', { family: null }),
      ],
      rows: [
        row('term-1', 'aseg:Brain-Stem', { d: -0.7, dLow: -1.1, dHigh: -0.2 }),
        row('term-1', 'aseg:bi:Thalamus', { d: 0.1, dLow: -0.3, dHigh: 0.5 }),
        row('term-2', 'aseg:bi:Thalamus', {
          F: 4.5,
          t: null,
          estimate: null,
          se: null,
          df1: 2,
          partialEta2: 0.09,
          partialR: null,
          partialRLow: null,
          partialRHigh: null,
          significant: true,
          pCorrected: 0.01,
        }),
        row('term-3', 'aseg:Brain-Stem', {
          inFamily: false,
          pCorrected: null,
        }),
      ],
    }
  }

  it('indexes the terms with the effect their grid cells show', async () => {
    const { termsCsv } = await load()
    expect(termsCsv(data()).split('\n')).toEqual([
      'term_id,test_id,label,kind,rank,role,family,stratum,focal,reference,rows,grid_effect',
      'term-1,test-1,Term term-1,t,1,effect,aseg,,AIS A,AIS B-D,2,d',
      // A formula-like label is neutralized and quoted text is escaped.
      `term-2,test-1,"'=Omnibus, ""all""",F,2,effect,aseg,,,,2,partial_eta2`,
      'term-3,test-1,Term term-3,t,1,effect,,,,,2,partial_r',
      '',
    ])
  })

  it('lays the grid out as measures by terms, blank where a term has no row', async () => {
    const { gridCsv } = await load()
    const lines = gridCsv(data()).trimEnd().split('\n')
    expect(lines[0]!.split(',').slice(0, 7)).toEqual([
      'measure_id',
      'term-1_effect',
      'term-1_effect_low',
      'term-1_effect_high',
      'term-1_p',
      'term-1_p_corrected',
      'term-1_significant',
    ])
    expect(lines.slice(1)).toEqual([
      'aseg:Brain-Stem,-0.7,-1.1,-0.2,0.04,0.08,false,,,,,,,-0.2,-0.4,0.01,0.04,,false',
      'aseg:bi:Thalamus,0.1,-0.3,0.5,0.04,0.08,false,0.09,,,0.04,0.01,true,,,,,,',
    ])
  })

  it('notes each atlas license from the catalog, a source, or FreeSurfer', async () => {
    const { atlasLicensesCsv } = await load()
    const base = data().spec
    const spec: GroupAnalysisSpecV2 = {
      ...base,
      measures: [
        'parc:schaefer400-7:lh:Vis_1:ThickAvg',
        'vol:user-0123abcd:mid:Medulla',
        'brainage:BrainPAD',
        'dk:lh:precentral:ThickAvg',
      ],
      covariates: {
        ...base.covariates,
        extra: [{ source: 'measure', column: 'global:SurfaceHoles' }],
      },
    }
    const catalog = {
      configRevision: 0,
      revision: 0,
      tools: [],
      subregionsPython: null,
      labeling: null,
      atlases: [
        {
          atlasId: 'user-0123abcd',
          label: 'Brainstem Navigator',
          tier: 'B' as const,
          kind: 'volume' as const,
          origin: 'added' as const,
          namespace: 'vol' as const,
          recipeId: 'user-volume' as const,
          externalSourceId: 'brainstem-navigator',
          available: true,
          unavailableReason: null,
          counts: {
            total: 1,
            withFiles: 0,
            labeled: 1,
            stale: 0,
            failed: 0,
            reconOutdated: 0,
          },
          estimateSeconds: null,
          license: {
            name: 'Navigator terms',
            url: 'https://www.nitrc.org/projects/brainstemnavig/',
            acknowledgedAt: '2026-09-30T12:00:00Z',
          },
          citation: 'Bianciardi M, et al.',
        },
      ],
    }
    const lines = atlasLicensesCsv(spec, { catalog, sources: null })
      .trimEnd()
      .split('\n')
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual([
      'aseg-global',
      'dk',
      'schaefer400-7',
      'user-0123abcd',
    ])
    expect(lines[1]).toContain(',FreeSurfer license,')
    expect(lines[3]).toContain(',GitHub (CBIG) (schaefer2018),,MIT,')
    expect(lines[4]).toBe(
      'user-0123abcd,Brainstem Navigator,added,NITRC (brainstem-navigator),,Navigator terms,https://www.nitrc.org/projects/brainstemnavig/,2026-09-30T12:00:00Z,"Bianciardi M, et al."',
    )
  })

  it('adds the v2 tables after the sidecar tables, even without atlas facts', async () => {
    const { writeAnalysisExport } = await load()
    const result = await writeAnalysisExport({
      parent: root,
      forbiddenRoots: [],
      request: request({
        figures: [{ kind: 'svg', stem: 'grid', svg: SVG, pdf: false }],
      }),
      exportData: async () => exportData(),
      pinResult,
      termData: async () => data(),
      atlasFacts: async () => {
        throw new Error('The workflow service stopped.')
      },
    })
    expect(result.files.map((f) => f.name)).toEqual([
      'results.csv',
      'spec.json',
      'terms.csv',
      'grid.csv',
      'atlas-licenses.csv',
      'grid.svg',
    ])
    const v1 = await writeAnalysisExport({
      parent: root,
      forbiddenRoots: [],
      request: request({ folderName: 'v1' }),
      exportData: async () => exportData(),
      pinResult,
      termData: async () => null,
    })
    expect(v1.files.map((f) => f.name)).toEqual(['results.csv', 'spec.json'])
  })
})
