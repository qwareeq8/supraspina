/**
 * Writes one group-analysis export: the results CSV, the optional
 * per-subject CSV, and the specification JSON from the sidecar's
 * `groupAnalysis.exportData`; for a v2 result, the term index, every
 * term's rows, the measures-by-terms grid, and the license notes of the
 * atlases its measures use; plus the renderer-drawn figures (SVG, PNG, and
 * PDF rendered from the SVG in a hidden sandboxed window).
 *
 * The folder is created exclusively under the operator-chosen parent and is
 * never overwritten; names follow `[a-z0-9._-]` with fixed extensions.
 * Exports are never registered in the Results inventory.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  BrowserWindow,
  dialog,
  session,
  type BrowserWindowConstructorOptions,
  type OpenDialogOptions,
  type Session,
} from 'electron'
import {
  ATLAS_SOURCES,
  BUILT_IN_ATLASES,
  type AtlasCatalog,
  type AtlasSourcesList,
} from '../shared/atlas-labeling'
import type { SaveDestination } from '../shared/contract'
import {
  GROUP_ANALYSIS_RESULT_ID,
  parseMeasureId,
  type AnalysisExportFigure,
  type GroupAnalysisExportData,
  type GroupAnalysisExportRequest,
  type GroupAnalysisExportResult,
  type GroupAnalysisRowV2,
  type GroupAnalysisSpecV2,
  type GroupAnalysisTerm,
} from '../shared/group-analysis'

/** An export folder or file stem: lowercase ASCII, digits, `.`, `_`, `-`. */
export const ANALYSIS_EXPORT_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/
/** The names tried for one export folder: the name, then `-2` to `-100`. */
export const MAX_EXPORT_FOLDER_TRIES = 100
/** The most figures one export writes. */
export const MAX_EXPORT_FIGURES = 16
/**
 * The largest `groupAnalysis.writeExport` IPC request, measured without
 * serializing it; every other IPC method keeps the 2 MiB cap.
 */
export const MAX_EXPORT_REQUEST_BYTES = 32 * 1024 * 1024
/** The largest SVG text or PNG one figure may carry. */
export const MAX_EXPORT_FIGURE_BYTES = MAX_EXPORT_REQUEST_BYTES
/**
 * The largest SVG rendered to PDF. Chromium refuses URLs over 2 MiB, and the
 * SVG travels base64-encoded in a `data:` URL.
 */
export const MAX_PDF_SVG_BYTES = 1535 * 1024
/** How long one PDF may take before the hidden window is destroyed. */
export const PDF_RENDER_TIMEOUT_MS = 30_000
/** The in-memory session of the PDF window; it refuses every fetch. */
export const ANALYSIS_PDF_PARTITION = 'supraspina-analysis-pdf'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MM_PER_UNIT: Readonly<Record<string, number>> = {
  mm: 1,
  cm: 10,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: 25.4 / 96,
  '': 25.4 / 96,
}
const MIN_FIGURE_MM = 1
const MAX_FIGURE_MM = 1000
/** Link errors of filesystems without hard links; they fall back to rename. */
const NO_HARD_LINKS = new Set([
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EXDEV',
  'EMLINK',
])

/** A figure's physical size, from its root `<svg>` element. */
export interface FigureSize {
  widthMm: number
  heightMm: number
}

/** Render one SVG document to PDF bytes at its physical size. */
export type PdfRenderer = (svg: string, size: FigureSize) => Promise<Uint8Array>

/** What choosing an export folder needs from main. */
export interface AnalysisExportFolderContext {
  projectRoot: string
  defaultName: string
  window: BrowserWindow | null
  /** The pipeline's output and derivatives folders, never an export parent. */
  forbiddenRoots: readonly string[]
  /** Register the chosen folder as an `analysis-export` destination grant. */
  register: (path: string) => SaveDestination
}

/** What writing an export needs from main. */
export interface AnalysisExportWriteContext {
  /** The consumed destination: the parent folder the operator chose. */
  parent: string
  /** The pipeline's output and derivatives folders, never an export parent. */
  forbiddenRoots: readonly string[]
  request: GroupAnalysisExportRequest
  /** Fetch the tables from the sidecar for this project generation. */
  exportData: (
    resultId: string,
    subjectCsv: boolean,
  ) => Promise<GroupAnalysisExportData>
  /** Keep the exported result past pruning; called after a written export. */
  pinResult: (resultId: string) => Promise<void>
  /**
   * Fetch a v2 result's terms, every term's rows, and its spec; null for a
   * v1 result, whose export keeps its three tables.
   */
  termData?: (resultId: string) => Promise<AnalysisExportTerms | null>
  /** Read the atlas licenses; a failure leaves the notes without them. */
  atlasFacts?: () => Promise<AnalysisExportAtlasFacts>
  /** Override the PDF renderer; the hidden window renders by default. */
  renderPdf?: PdfRenderer
}

/** A v2 result's terms and rows, for the term and grid tables. */
export interface AnalysisExportTerms {
  terms: GroupAnalysisTerm[]
  /** Every row of every term. */
  rows: GroupAnalysisRowV2[]
  spec: GroupAnalysisSpecV2
}

/** What the atlas license notes read: the project catalog and the sources. */
export interface AnalysisExportAtlasFacts {
  catalog: AtlasCatalog | null
  sources: AtlasSourcesList | null
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

/**
 * Refuse an export parent inside a pipeline output or derivatives folder,
 * by its given and its real path, so a link cannot place an export there.
 *
 * @throws Error when the parent is inside one of them.
 */
export async function assertExportParentAllowed(
  parent: string,
  roots: readonly string[],
): Promise<void> {
  const given = resolve(parent)
  const real = await realpath(given).catch(() => given)
  for (const root of roots) {
    const plain = resolve(root)
    const realRoot = await realpath(plain).catch(() => plain)
    if (within(plain, given) || within(realRoot, real)) {
      throw new Error(
        'Choose an export folder outside the pipeline output and derivatives folders.',
      )
    }
  }
}

/**
 * Show the folder dialog, starting at `<projectRoot>/exports/analysis`.
 *
 * The export folder itself (`defaultName` or the name the renderer sends to
 * `writeExport`) is created inside the chosen folder later.
 *
 * @returns The destination grant, or null when the operator cancels.
 * @throws Error when the choice is not a real folder.
 */
export async function chooseAnalysisExportFolder(
  context: AnalysisExportFolderContext,
): Promise<SaveDestination | null> {
  const defaultParent = join(context.projectRoot, 'exports', 'analysis')
  const created = await mkdir(defaultParent, { recursive: true })
    .then(() => true)
    .catch(() => false)
  const options: OpenDialogOptions = {
    title: 'Choose the export folder',
    buttonLabel: 'Choose folder',
    message: `Supraspina creates ${context.defaultName} inside the chosen folder.`,
    defaultPath: created ? defaultParent : context.projectRoot,
    properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
  }
  const result = context.window
    ? await dialog.showOpenDialog(context.window, options)
    : await dialog.showOpenDialog(options)
  const path = result.canceled ? undefined : result.filePaths[0]
  if (!path) return null
  if (!isAbsolute(path) || /[\r\n\0]/.test(path)) {
    throw new Error('Choose a valid export folder.')
  }
  const info = await lstat(path).catch(() => null)
  if (!info?.isDirectory()) {
    throw new Error('Choose an existing folder, not a file or a link.')
  }
  await assertExportParentAllowed(path, context.forbiddenRoots)
  return context.register(path)
}

function skipSpace(text: string, from: number): number {
  let index = from
  while (index < text.length && /\s/.test(text[index]!)) index++
  return index
}

/**
 * Find the root `<svg` tag of an SVG document in one linear scan: an optional
 * BOM, an optional XML declaration, then comments and whitespace. A regular
 * expression with a repeated lazy comment group backtracks exponentially on
 * unterminated input, so the prologue is skipped with `indexOf`.
 *
 * @returns The root tag through its first `>`, or null when the document does
 *   not start with one.
 */
export function svgRootTag(text: string): string | null {
  let index = skipSpace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0)
  if (text.startsWith('<?xml', index)) {
    const end = text.indexOf('?>', index + 5)
    if (end < 0) return null
    index = skipSpace(text, end + 2)
  }
  while (text.startsWith('<!--', index)) {
    const end = text.indexOf('-->', index + 4)
    if (end < 0) return null
    index = skipSpace(text, end + 3)
  }
  if (!text.startsWith('<svg', index)) return null
  const next = text[index + 4]
  if (next === undefined || !/[\s>]/.test(next)) return null
  const close = text.indexOf('>', index + 4)
  return close < 0 ? null : text.slice(index, close + 1)
}

/** Elements that run script or embed HTML, with or without a prefix. */
const SVG_ACTIVE_ELEMENT = /<\s*(?:[\w.-]+:)?(?:script|foreignObject)\b/i
/**
 * The start of every `href` or `xlink:href` value and CSS `url()` target;
 * only the first five characters are read, so each match is bounded.
 */
const SVG_TARGETS = [
  /\bhref\s*=\s*["']?\s*([^]{0,5})/gi,
  /\burl\(\s*["']?\s*([^]{0,5})/gi,
]

function inlineTarget(start: string): boolean {
  return start.startsWith('#') || /^data:/i.test(start)
}

/**
 * Say whether an SVG is inert: no script or foreign HTML, no CSS import,
 * and every `href` and `url()` a fragment (`#id`) or inline `data:` (fonts).
 * The PDF window blocks every fetch anyway; this keeps such figures out of
 * the export folder too.
 *
 * @returns True when the figure references nothing outside itself.
 */
export function svgIsInert(svg: string): boolean {
  if (SVG_ACTIVE_ELEMENT.test(svg) || /@import\b/i.test(svg)) return false
  for (const pattern of SVG_TARGETS) {
    for (const match of svg.matchAll(pattern)) {
      if (!inlineTarget(match[1] ?? '')) return false
    }
  }
  return true
}

function mmFromLength(value: string | null): number | null {
  if (value === null) return null
  const match =
    /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(mm|cm|in|pt|pc|px)?\s*$/i.exec(value)
  if (!match) return null
  const scale = MM_PER_UNIT[(match[2] ?? '').toLowerCase()]
  const mm = Number(match[1]) * (scale ?? Number.NaN)
  return Number.isFinite(mm) ? mm : null
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(
    tag,
  )
  return match ? (match[1] ?? match[2] ?? null) : null
}

/**
 * Read a figure's physical size from its root `<svg>` element: `width` and
 * `height` with units (a unitless value is CSS pixels at 96 per inch), else
 * the `viewBox` in CSS pixels.
 *
 * @returns The size in millimeters.
 * @throws Error when the size is missing or outside 1 to 1000 mm.
 */
export function svgFigureSize(svg: string): FigureSize {
  const tag = svgRootTag(svg) ?? ''
  let widthMm = mmFromLength(attribute(tag, 'width'))
  let heightMm = mmFromLength(attribute(tag, 'height'))
  if (widthMm === null || heightMm === null) {
    const box = (attribute(tag, 'viewBox') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    if (box.length === 4 && box.every(Number.isFinite)) {
      widthMm ??= box[2]! * MM_PER_UNIT.px!
      heightMm ??= box[3]! * MM_PER_UNIT.px!
    }
  }
  if (
    widthMm === null ||
    heightMm === null ||
    widthMm < MIN_FIGURE_MM ||
    heightMm < MIN_FIGURE_MM ||
    widthMm > MAX_FIGURE_MM ||
    heightMm > MAX_FIGURE_MM
  ) {
    throw new Error('Size each SVG figure between 1 and 1000 mm.')
  }
  return { widthMm, heightMm }
}

const guardedSessions = new WeakSet<Session>()

/** Return the PDF session, refusing every fetch that is not inline data. */
function pdfSession(): Session {
  const pdf = session.fromPartition(ANALYSIS_PDF_PARTITION, { cache: false })
  if (!guardedSessions.has(pdf)) {
    // The document is the figure's own data: URL; nothing else may load.
    pdf.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('data:') })
    })
    pdf.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    pdf.setPermissionCheckHandler(() => false)
    // A data: document can still start a download; nothing leaves this way.
    pdf.on('will-download', (event, item) => {
      event.preventDefault()
      item.cancel()
    })
    guardedSessions.add(pdf)
  }
  return pdf
}

/**
 * The hidden PDF window: no script, no preload, no Node, and a session that
 * refuses every fetch.
 */
export function pdfWindowOptions(
  pdf: Session,
): BrowserWindowConstructorOptions {
  return {
    show: false,
    width: 800,
    height: 600,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      session: pdf,
      sandbox: true,
      javascript: false,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webgl: false,
      plugins: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      disableDialogs: true,
      autoplayPolicy: 'user-gesture-required',
    },
  }
}

/**
 * Render one SVG to a one-page PDF of its physical size in a hidden,
 * sandboxed, script-free window that is always destroyed.
 *
 * @param svg - The SVG document, at most `MAX_PDF_SVG_BYTES`.
 * @param size - The page size in millimeters.
 * @throws Error when loading or printing fails or exceeds the timeout.
 */
export async function renderSvgToPdf(
  svg: string,
  size: FigureSize,
): Promise<Uint8Array> {
  if (Buffer.byteLength(svg, 'utf8') > MAX_PDF_SVG_BYTES) {
    throw new Error('Export figures over 1.5 MiB without a PDF.')
  }
  const win = new BrowserWindow(pdfWindowOptions(pdfSession()))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const contents = win.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    const url = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
    const render = (async () => {
      await win.loadURL(url)
      return contents.printToPDF({
        pageSize: {
          width: size.widthMm / 25.4,
          height: size.heightMm / 25.4,
        },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        printBackground: true,
        displayHeaderFooter: false,
        landscape: false,
      })
    })()
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Rendering the PDF took over 30 seconds.')),
        PDF_RENDER_TIMEOUT_MS,
      )
    })
    render.catch(() => undefined)
    return await Promise.race([render, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (!win.isDestroyed()) win.destroy()
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Publish one file under a name that must not exist: write a temporary
 * sibling, then link it into place (or rename it where hard links are
 * unsupported, after checking the name is free).
 */
async function publishExclusive(
  folder: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = join(folder, name)
  const temporary = join(folder, `.${name}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, target)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(`Keep ${name} unique; the export never overwrites.`, {
        cause: error,
      })
    }
    if (!NO_HARD_LINKS.has(errorCode(error) ?? '')) throw error
    if (await lstat(target).catch(() => null)) {
      throw new Error(`Keep ${name} unique; the export never overwrites.`, {
        cause: error,
      })
    }
    await rename(temporary, target)
    return
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r').catch(() => null)
  try {
    await handle?.sync()
  } catch {
    // Tolerate filesystems without directory fsync.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** The first characters a spreadsheet would run as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r']

/**
 * Render one CSV cell as the sidecar's tables do: empty for null, `true` or
 * `false`, the shortest round-trip number, and text with a leading
 * apostrophe when a spreadsheet would run it as a formula; quoted when it
 * holds a comma, quote, or line break.
 */
function csvCell(value: string | number | boolean | null): string {
  let text: string
  if (value === null) text = ''
  else if (typeof value === 'boolean') text = value ? 'true' : 'false'
  else if (typeof value === 'number') text = String(value)
  else {
    text = FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix))
      ? `'${value}`
      : value
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function csvText(
  header: readonly string[],
  rows: Iterable<readonly (string | number | boolean | null)[]>,
): string {
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return `${lines.join('\n')}\n`
}

/** The effect a term's grid cells show, with its interval when it has one. */
type TermEffect = 'd' | 'partial_r' | 'partial_eta2'

function termEffect(
  term: GroupAnalysisTerm,
  rows: GroupAnalysisRowV2[],
): TermEffect {
  if (term.kind === 'F') return 'partial_eta2'
  return rows.some((row) => row.d !== null) ? 'd' : 'partial_r'
}

function effectOf(
  effect: TermEffect,
  row: GroupAnalysisRowV2,
): [number | null, number | null, number | null] {
  if (effect === 'd') return [row.d, row.dLow, row.dHigh]
  if (effect === 'partial_r') {
    return [row.partialR, row.partialRLow, row.partialRHigh]
  }
  return [row.partialEta2, null, null]
}

function rowsByTerm(
  data: AnalysisExportTerms,
): Map<string, GroupAnalysisRowV2[]> {
  const byTerm = new Map<string, GroupAnalysisRowV2[]>(
    data.terms.map((term) => [term.termId, []]),
  )
  for (const row of data.rows) byTerm.get(row.termId)?.push(row)
  return byTerm
}

/**
 * Render `terms.csv`: one row per term with what it tests and the effect
 * its grid cells show.
 */
export function termsCsv(data: AnalysisExportTerms): string {
  const byTerm = rowsByTerm(data)
  return csvText(
    [
      'term_id',
      'test_id',
      'label',
      'kind',
      'rank',
      'role',
      'family',
      'stratum',
      'focal',
      'reference',
      'rows',
      'grid_effect',
    ],
    data.terms.map((term) => [
      term.termId,
      term.testId,
      term.label,
      term.kind,
      term.rank,
      term.role,
      term.family,
      term.stratum,
      term.pair?.focal ?? null,
      term.pair?.reference ?? null,
      term.rowCount,
      termEffect(term, byTerm.get(term.termId) ?? []),
    ]),
  )
}

/**
 * Render `grid.csv`: one row per measure (in the spec's order) and, per
 * term, its effect with the interval, p, corrected p, and significance,
 * like the Grid tab. `terms.csv` names each term's effect.
 */
export function gridCsv(data: AnalysisExportTerms): string {
  const byTerm = rowsByTerm(data)
  const columns = data.terms.map((term) => {
    const rows = byTerm.get(term.termId) ?? []
    return {
      term,
      effect: termEffect(term, rows),
      byMeasure: new Map(rows.map((row) => [row.measureId, row])),
    }
  })
  const measures = [
    ...data.spec.measures,
    ...new Set(
      data.rows
        .map((row) => row.measureId)
        .filter((id) => !data.spec.measures.includes(id)),
    ),
  ].filter((id) => columns.some((column) => column.byMeasure.has(id)))
  return csvText(
    [
      'measure_id',
      ...columns.flatMap(({ term }) =>
        [
          'effect',
          'effect_low',
          'effect_high',
          'p',
          'p_corrected',
          'significant',
        ].map((part) => `${term.termId}_${part}`),
      ),
    ],
    measures.map((measureId) => [
      measureId,
      ...columns.flatMap(({ effect, byMeasure }) => {
        const row = byMeasure.get(measureId)
        if (!row) return [null, null, null, null, null, null]
        return [
          ...effectOf(effect, row),
          row.p,
          row.pCorrected,
          row.significant,
        ]
      }),
    ]),
  )
}

/** The atlas a measure reads, or null for Brain-PAD. */
function measureAtlas(id: string): string | null {
  const parsed = parseMeasureId(id)
  if (!parsed) return null
  switch (parsed.source) {
    case 'dk':
    case 'aseg':
      return parsed.source
    case 'global':
      return 'aseg-global'
    case 'brainage':
      return null
    case 'parc':
    case 'vol':
      return parsed.atlas
  }
}

/** Every measure a spec reads: its measures and measure covariates. */
function specMeasureIds(spec: GroupAnalysisSpecV2): string[] {
  const found = new Set(spec.measures)
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    if (record.source === 'measure' && typeof record.column === 'string') {
      found.add(record.column)
    }
    for (const item of Object.values(record)) visit(item, depth + 1)
  }
  visit(spec, 0)
  return [...found]
}

const FREESURFER_LICENSE = {
  name: 'FreeSurfer license',
  url: 'https://surfer.nmr.mgh.harvard.edu/fswiki/FreeSurferSoftwareLicense',
}

/**
 * Render `atlas-licenses.csv`: each atlas the result's measures use, where
 * it came from, its license (and when the operator acknowledged it), and
 * what to cite. The project's atlas catalog speaks first (added atlases
 * carry the license the operator confirmed); then a pinned source; then
 * FreeSurfer, which ships every built-in atlas.
 *
 * @param facts - The atlas catalog and source list, when read.
 */
export function atlasLicensesCsv(
  spec: GroupAnalysisSpecV2,
  facts: AnalysisExportAtlasFacts,
): string {
  const atlasIds = [
    ...new Set(
      specMeasureIds(spec)
        .map(measureAtlas)
        .filter((id): id is string => id !== null),
    ),
  ].sort()
  const rows = atlasIds.map((atlasId) => {
    const entry = facts.catalog?.atlases.find(
      (item) => item.atlasId === atlasId,
    )
    const source = ATLAS_SOURCES.find(
      (item) =>
        item.atlasIds.includes(atlasId) ||
        (entry?.externalSourceId ?? null) === item.sourceId,
    )
    const builtIn = BUILT_IN_ATLASES.find((item) => item.atlasId === atlasId)
    const cached = source
      ? facts.sources?.sources.find(
          (item) => item.source.sourceId === source.sourceId,
        )?.cached
      : undefined
    const license =
      entry?.license ??
      (source
        ? { ...source.license, acknowledgedAt: null }
        : builtIn
          ? { ...FREESURFER_LICENSE, acknowledgedAt: null }
          : null)
    return [
      atlasId,
      entry?.label ?? builtIn?.label ?? source?.label ?? atlasId,
      entry?.origin ?? builtIn?.origin ?? (source ? 'added' : null),
      source
        ? `${source.site} (${source.sourceId})`
        : builtIn
          ? 'FreeSurfer'
          : null,
      cached?.version ?? null,
      license?.name ?? 'No license recorded',
      license?.url ?? null,
      license?.acknowledgedAt ?? null,
      entry?.citation ??
        source?.citation ??
        (builtIn
          ? 'See the FreeSurfer documentation for the papers to cite.'
          : null),
    ] as const
  })
  return csvText(
    [
      'atlas_id',
      'atlas',
      'origin',
      'source',
      'cached_version',
      'license',
      'license_url',
      'license_acknowledged_at',
      'citation',
    ],
    rows,
  )
}

function checkExportData(
  data: GroupAnalysisExportData,
  request: GroupAnalysisExportRequest,
): void {
  if (data.resultId !== request.resultId) {
    throw new Error('The workflow service returned another result to export.')
  }
  const expected = [
    'results.csv',
    ...(request.subjectCsv ? ['subjects.csv'] : []),
    'spec.json',
  ]
  const names: string[] = data.files.map((file) => file.name)
  if (
    names.length !== expected.length ||
    expected.some((name) => !names.includes(name))
  ) {
    throw new Error('The workflow service returned the wrong export tables.')
  }
}

/**
 * Create a new export folder: the requested name, or when it exists the
 * next free `-2`, `-3`, ... suffix. Each try is an exclusive `mkdir`, so a
 * folder created concurrently is never reused and nothing is overwritten.
 *
 * @throws Error when every name through `-100` exists.
 */
async function createExportFolder(
  parent: string,
  name: string,
): Promise<string> {
  for (let index = 1; index <= MAX_EXPORT_FOLDER_TRIES; index++) {
    const suffix = index === 1 ? '' : `-${index}`
    // Stay within the 128-character name limit.
    const candidate = `${name.slice(0, 128 - suffix.length)}${suffix}`
    try {
      await mkdir(join(parent, candidate))
      return candidate
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  throw new Error(
    `Choose another export folder; ${name} and its numbered copies through -${MAX_EXPORT_FOLDER_TRIES} already exist there.`,
  )
}

/**
 * Create the export folder exclusively and write every file through a
 * temporary name and an exclusive link or rename.
 *
 * Everything is prepared in memory first (tables, figures, PDFs), so a
 * failure before the folder exists leaves nothing behind; a failure while
 * writing removes the files written and the folder.
 *
 * @param context - The consumed destination, request, data source, and the pin
 *   hook, which runs only after every file is written.
 * @returns The folder and its name (suffixed when the requested one existed),
 *   each file's size and SHA-256, and provisionality.
 * @throws Error when no folder name is free, a file exists, or rendering fails.
 */
export async function writeAnalysisExport(
  context: AnalysisExportWriteContext,
): Promise<GroupAnalysisExportResult> {
  const { parent, request } = context
  const parentInfo = await lstat(parent).catch(() => null)
  if (!parentInfo?.isDirectory()) {
    throw new Error('Choose an existing export folder again.')
  }
  await assertExportParentAllowed(parent, context.forbiddenRoots)
  const data = await context.exportData(request.resultId, request.subjectCsv)
  checkExportData(data, request)
  const order = ['results.csv', 'subjects.csv', 'spec.json']
  const files: { name: string; bytes: Uint8Array }[] = [...data.files]
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
    .map((file) => ({ name: file.name, bytes: Buffer.from(file.text, 'utf8') }))
  const terms = (await context.termData?.(request.resultId)) ?? null
  if (terms !== null) {
    const facts = await (
      context.atlasFacts?.() ??
      Promise.resolve({ catalog: null, sources: null })
    ).catch(() => ({ catalog: null, sources: null }))
    for (const [name, text] of [
      ['terms.csv', termsCsv(terms)],
      ['grid.csv', gridCsv(terms)],
      ['atlas-licenses.csv', atlasLicensesCsv(terms.spec, facts)],
    ] as const) {
      files.push({ name, bytes: Buffer.from(text, 'utf8') })
    }
  }
  const renderPdf = context.renderPdf ?? renderSvgToPdf
  for (const figure of request.figures) {
    if (figure.kind === 'png') {
      files.push({ name: `${figure.stem}.png`, bytes: figure.png })
      continue
    }
    files.push({
      name: `${figure.stem}.svg`,
      bytes: Buffer.from(figure.svg, 'utf8'),
    })
    if (figure.pdf) {
      files.push({
        name: `${figure.stem}.pdf`,
        bytes: await renderPdf(figure.svg, svgFigureSize(figure.svg)),
      })
    }
  }
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw new Error('Give each exported file a different name.')
  }

  const folderName = await createExportFolder(parent, request.folderName)
  const folder = join(parent, folderName)
  const written: string[] = []
  try {
    for (const file of files) {
      await publishExclusive(folder, file.name, file.bytes)
      written.push(file.name)
    }
    await fsyncDirectory(folder)
    await fsyncDirectory(parent)
  } catch (error) {
    for (const name of written) {
      await unlink(join(folder, name)).catch(() => undefined)
    }
    await rmdir(folder).catch(() => undefined)
    throw error
  }
  // The export is on disk either way; an unpinned result is only prunable.
  await context.pinResult(request.resultId).catch(() => undefined)
  return {
    displayPath: folder,
    folderName,
    files: files.map((file) => ({
      name: file.name,
      bytes: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
    provisional: data.provisional,
  }
}

function isPng(bytes: Uint8Array): boolean {
  // The signature, then the IHDR chunk (length 13) every PNG starts with.
  return (
    bytes.byteLength > 33 &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value) &&
    bytes[11] === 13 &&
    String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR'
  )
}

function parseFigure(value: unknown): AnalysisExportFigure {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provide valid export figures.')
  }
  const figure = value as Record<string, unknown>
  const stem = figure.stem
  if (typeof stem !== 'string' || !ANALYSIS_EXPORT_NAME.test(stem)) {
    throw new Error('Name each figure with [a-z0-9._-] characters.')
  }
  if (figure.kind === 'svg') {
    if (
      Object.keys(figure).sort().join(',') !== 'kind,pdf,stem,svg' ||
      typeof figure.svg !== 'string' ||
      typeof figure.pdf !== 'boolean' ||
      Buffer.byteLength(figure.svg, 'utf8') > MAX_EXPORT_FIGURE_BYTES ||
      svgRootTag(figure.svg) === null ||
      // Entity declarations can expand without bound in the PDF renderer.
      /<!(?:DOCTYPE|ENTITY)/i.test(figure.svg) ||
      figure.svg.includes('\0') ||
      !svgIsInert(figure.svg)
    ) {
      throw new Error('Provide a valid SVG figure.')
    }
    if (figure.pdf) {
      if (Buffer.byteLength(figure.svg, 'utf8') > MAX_PDF_SVG_BYTES) {
        throw new Error('Export figures over 1.5 MiB without a PDF.')
      }
      svgFigureSize(figure.svg)
    }
    return { kind: 'svg', stem, svg: figure.svg, pdf: figure.pdf }
  }
  if (figure.kind === 'png') {
    if (
      Object.keys(figure).sort().join(',') !== 'kind,png,stem' ||
      !(figure.png instanceof Uint8Array) ||
      figure.png.byteLength > MAX_EXPORT_FIGURE_BYTES ||
      !isPng(figure.png)
    ) {
      throw new Error('Provide a valid PNG figure.')
    }
    return { kind: 'png', stem, png: figure.png }
  }
  throw new Error('Provide SVG or PNG figures.')
}

/**
 * Check a `groupAnalysis.writeExport` request without its project reference.
 *
 * @throws Error naming the first problem.
 */
export function parseAnalysisExportRequest(
  value: Record<string, unknown>,
): GroupAnalysisExportRequest {
  const keys = Object.keys(value).sort().join(',')
  if (keys !== 'destinationId,figures,folderName,resultId,subjectCsv') {
    throw new Error('Correct the invalid fields in the export request.')
  }
  if (typeof value.destinationId !== 'string') {
    throw new Error('Choose an export folder first.')
  }
  if (
    typeof value.resultId !== 'string' ||
    !GROUP_ANALYSIS_RESULT_ID.test(value.resultId)
  ) {
    throw new Error('Provide a valid analysis result ID.')
  }
  if (
    typeof value.folderName !== 'string' ||
    !ANALYSIS_EXPORT_NAME.test(value.folderName)
  ) {
    throw new Error('Name the export folder with [a-z0-9._-] characters.')
  }
  if (typeof value.subjectCsv !== 'boolean') {
    throw new Error('Send subjectCsv as true or false.')
  }
  if (
    !Array.isArray(value.figures) ||
    value.figures.length > MAX_EXPORT_FIGURES
  ) {
    throw new Error(`Export at most ${MAX_EXPORT_FIGURES} figures.`)
  }
  const figures = value.figures.map(parseFigure)
  if (
    new Set(figures.map((f) => `${f.kind}:${f.stem}`)).size !== figures.length
  ) {
    throw new Error('Give each figure a different name.')
  }
  return {
    destinationId: value.destinationId,
    resultId: value.resultId,
    folderName: value.folderName,
    subjectCsv: value.subjectCsv,
    figures,
  }
}

/** The deepest nesting the bounded request measure walks. */
const MAX_MEASURED_DEPTH = 8

/**
 * Measure an IPC request without serializing it, stopping at the limit.
 *
 * `JSON.stringify` would expand a PNG's bytes about fourfold before the cap
 * applies, so the export request is measured structurally instead: strings
 * by UTF-8 length, a `Uint8Array` by its backing buffer, 8 bytes per
 * scalar. Any other structured-clone type, or nesting past
 * `MAX_MEASURED_DEPTH`, is refused.
 *
 * @param limit - The limit in bytes.
 * @returns The measured size, or `limit + 1` once it is exceeded.
 * @throws Error on an unsupported value or nesting.
 */
export function boundedRequestBytes(value: unknown, limit: number): number {
  let total = 0
  const visit = (item: unknown, depth: number): void => {
    if (total > limit) return
    if (depth > MAX_MEASURED_DEPTH) {
      throw new Error('Send a shallower IPC request.')
    }
    if (
      item === null ||
      typeof item === 'boolean' ||
      typeof item === 'number'
    ) {
      total += 8
      return
    }
    if (typeof item === 'string') {
      total += Buffer.byteLength(item, 'utf8') + 2
      return
    }
    if (item instanceof Uint8Array) {
      // Count the backing buffer: structured clone transfers all of it.
      total += Math.max(item.byteLength, item.buffer.byteLength)
      return
    }
    if (Array.isArray(item)) {
      total += 2
      for (const entry of item) {
        visit(entry, depth + 1)
        if (total > limit) return
      }
      return
    }
    if (
      typeof item === 'object' &&
      Object.getPrototypeOf(item) === Object.prototype
    ) {
      total += 2
      for (const [key, entry] of Object.entries(item)) {
        total += Buffer.byteLength(key, 'utf8') + 3
        visit(entry, depth + 1)
        if (total > limit) return
      }
      return
    }
    throw new Error('Send a JSON-serializable IPC request.')
  }
  visit(value, 0)
  return total > limit ? limit + 1 : total
}
