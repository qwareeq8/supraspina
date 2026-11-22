/**
 * The external atlas sources and their machine-level cache,
 * `<userData>/atlases/<sourceId>/<version>/` with a `manifest.json`
 * (`AtlasCacheManifest`), shared by every project.
 *
 * A download follows the PyBrainAge provisioning pattern (license shown and
 * acknowledged first, progress, cancel, size and SHA-256 checks) but is a
 * separate, advisory mechanism: it never touches the managed scientific
 * resources, `SCIENTIFIC_RESOURCE_PINS.json`, the environment check, or
 * receipts. Only sources whose files are pinned (URL, size, SHA-256) and
 * served from an allowlisted https host download; each file is fetched
 * without redirects into a private staging folder, bounded by its pinned
 * size, hashed while it streams, and the verified set with its manifest
 * replaces the version folder in one rename, so a cancelled or failed
 * download leaves nothing partial behind. `openPage` opens only a source's
 * allowlisted https page.
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ATLAS_CACHE_SCHEMA,
  ATLAS_DOWNLOAD_OPERATION_ID,
  ATLAS_SOURCES,
  atlasSourceUrl,
  type AtlasSourceUrlKind,
  type AtlasCacheManifest,
  type AtlasDownloadCancelResult,
  type AtlasDownloadOperation,
  type AtlasDownloadStartResult,
  type AtlasDownloadStatus,
  type AtlasSource,
  type AtlasSourceCacheState,
  type AtlasSourceListing,
  type AtlasSourcesList,
} from '../shared/atlas-labeling'

/** The only hosts atlas files download from (https, no redirects). */
export const ATLAS_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  'raw.githubusercontent.com',
])
/** The manifest file inside a source version folder. */
export const ATLAS_MANIFEST_NAME = 'manifest.json'
/** The largest manifest main reads. */
const MAX_MANIFEST_BYTES = 256 * 1024
/** The largest file a source may pin. */
const MAX_SOURCE_FILE_BYTES = 512 * 1024 * 1024
/** A source ID as a folder name (`atlas_sources.cache_dir`). */
const SOURCE_ID = /^[a-z][a-z0-9-]{1,63}$/
/** A version as a folder name (`atlas_sources.cache_dir`). */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** One segment of a cache-relative path. */
const RELPATH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/
const SHA256 = /^[a-f0-9]{64}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
/** Staging folders a download writes before it publishes. */
const STAGING_PREFIX = '.staging-'
/** Version folders set aside while a new one is published. */
const RETIRED_PREFIX = '.retired-'

/** A download failure whose message the panel shows as is. */
class AtlasDownloadError extends Error {}

/** The machine-level cache folder of every downloaded or imported atlas. */
export function atlasCacheRoot(userDataPath: string): string {
  return join(userDataPath, 'atlases')
}

/** The subset of `fetch` the downloader uses. */
export type AtlasFetch = (
  url: string,
  init: { redirect: 'error'; signal: AbortSignal },
) => Promise<Response>

/** What the atlas source manager needs from main. */
export interface AtlasSourceContext {
  /** Electron's userData folder. */
  userDataPath: string
  /** Open an allowlisted https URL in the operator's browser. */
  openExternal: (url: string) => Promise<void>
  /** Fetch a file; Electron's `net.fetch` in the app. */
  fetch?: AtlasFetch
  /** The current time; tests fix it. */
  now?: () => Date
}

/** Say whether a cache-relative path is safe: 1 to 5 plain segments. */
function isRelpath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('/')
  return (
    parts.length <= 5 &&
    parts.every(
      (part) => RELPATH_SEGMENT.test(part) && part !== '.' && part !== '..',
    )
  )
}

/**
 * Say whether a URL is an allowed download: https on an allowlisted host,
 * default port, no credentials, query, or fragment.
 */
export function isAllowedAtlasDownload(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    ATLAS_DOWNLOAD_HOSTS.has(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.href === raw
  )
}

/** Say whether a source may offer "Download from <site>". */
function isDownloadable(source: AtlasSource): boolean {
  return (
    source.files.length > 0 &&
    !source.requiresLogin &&
    SOURCE_ID.test(source.sourceId) &&
    VERSION.test(source.version) &&
    new Set(source.files.map((file) => file.relpath)).size ===
      source.files.length &&
    source.files.every(
      (file) =>
        isAllowedAtlasDownload(file.url) &&
        SHA256.test(file.sha256) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0 &&
        file.bytes <= MAX_SOURCE_FILE_BYTES &&
        isRelpath(file.relpath) &&
        file.relpath !== ATLAS_MANIFEST_NAME,
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

/**
 * Validate a cache manifest for one source version.
 *
 * @returns The manifest, or null when it breaks the schema or names another
 *   source or version.
 */
export function parseAtlasCacheManifest(
  value: unknown,
  source: AtlasSource,
): AtlasCacheManifest | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schema',
      'schemaVersion',
      'sourceId',
      'version',
      'provenance',
      'files',
      'license',
      'retrievedAt',
    ]) ||
    value.schema !== ATLAS_CACHE_SCHEMA ||
    value.schemaVersion !== 1 ||
    value.sourceId !== source.sourceId ||
    value.version !== source.version ||
    (value.provenance !== 'downloaded' && value.provenance !== 'imported') ||
    typeof value.retrievedAt !== 'string' ||
    !ISO_TIMESTAMP.test(value.retrievedAt) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > 64 ||
    !isRecord(value.license) ||
    !exactKeys(value.license, ['name', 'url', 'acknowledgedAt']) ||
    typeof value.license.name !== 'string' ||
    value.license.name.length === 0 ||
    value.license.name.length > 120 ||
    !(
      value.license.url === null ||
      (typeof value.license.url === 'string' &&
        value.license.url.startsWith('https://') &&
        value.license.url.length <= 2048)
    ) ||
    typeof value.license.acknowledgedAt !== 'string' ||
    !ISO_TIMESTAMP.test(value.license.acknowledgedAt)
  ) {
    return null
  }
  const files: AtlasCacheManifest['files'] = []
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      !exactKeys(file, ['relpath', 'url', 'sha256', 'bytes']) ||
      !isRelpath(file.relpath) ||
      file.relpath === ATLAS_MANIFEST_NAME ||
      !(file.url === null || typeof file.url === 'string') ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0
    ) {
      return null
    }
    files.push({
      relpath: file.relpath,
      url: file.url,
      sha256: file.sha256,
      bytes: file.bytes as number,
    })
  }
  if (new Set(files.map((file) => file.relpath)).size !== files.length) {
    return null
  }
  return {
    schema: ATLAS_CACHE_SCHEMA,
    schemaVersion: 1,
    sourceId: source.sourceId,
    version: source.version,
    provenance: value.provenance,
    files,
    license: {
      name: value.license.name,
      url: value.license.url,
      acknowledgedAt: value.license.acknowledgedAt,
    },
    retrievedAt: value.retrievedAt,
  }
}

/** Read a small regular file without following a final link. */
async function readSmallFile(path: string, limit: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) {
      throw new Error('The manifest is not a small regular file.')
    }
    const data = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(data, 0, info.size, 0)
    return data.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Remove a folder this manager created, ignoring one that is gone. */
async function removeFolder(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined)
}

/** Stream one response body into a new file, bounded and hashed. */
async function writeBody(
  response: Response,
  handle: FileHandle,
  limit: number,
  signal: AbortSignal,
  onBytes: (count: number) => void,
): Promise<{ bytes: number; sha256: string }> {
  const body = response.body
  if (body === null) {
    throw new AtlasDownloadError(
      'The atlas site sent no data; try again later.',
    )
  }
  const hash = createHash('sha256')
  const reader = body.getReader()
  // A cancel settles a pending read even when the body ignores the signal.
  const stop = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', stop, { once: true })
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) throw new Error('The atlas download was cancelled.')
      const { done, value } = await reader.read()
      if (signal.aborted) throw new Error('The atlas download was cancelled.')
      if (done) break
      total += value.byteLength
      if (total > limit) {
        throw new AtlasDownloadError(
          'The atlas download is larger than its pinned size; nothing was kept.',
        )
      }
      hash.update(value)
      await handle.write(value)
      onBytes(value.byteLength)
    }
  } finally {
    signal.removeEventListener('abort', stop)
    await reader.cancel().catch(() => undefined)
  }
  return { bytes: total, sha256: hash.digest('hex') }
}

/** Download, list, and open the external atlas sources (one download at a time). */
export class AtlasSourceManager {
  private operation: AtlasDownloadOperation | null = null
  private controller: AbortController | null = null
  private task: Promise<void> | null = null

  constructor(private readonly context: AtlasSourceContext) {}

  private now(): string {
    return (this.context.now?.() ?? new Date()).toISOString()
  }

  private root(): string {
    return atlasCacheRoot(this.context.userDataPath)
  }

  private versionFolder(source: AtlasSource): string {
    return join(this.root(), source.sourceId, source.version)
  }

  /**
   * Read one source's cache state. A manifest that breaks the schema, a
   * listed file that is missing, a link, or of another size, or a
   * downloaded manifest that no longer matches the pins is `corrupt`.
   */
  private async cacheState(source: AtlasSource): Promise<{
    state: AtlasSourceCacheState
    cached: AtlasSourceListing['cached']
  }> {
    if (!SOURCE_ID.test(source.sourceId) || !VERSION.test(source.version)) {
      return { state: 'absent', cached: null }
    }
    const folder = this.versionFolder(source)
    let text: string
    try {
      text = await readSmallFile(
        join(folder, ATLAS_MANIFEST_NAME),
        MAX_MANIFEST_BYTES,
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return {
        state: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'corrupt',
        cached: null,
      }
    }
    let manifest: AtlasCacheManifest | null
    try {
      manifest = parseAtlasCacheManifest(JSON.parse(text), source)
    } catch {
      manifest = null
    }
    if (manifest === null) return { state: 'corrupt', cached: null }
    if (manifest.provenance === 'downloaded') {
      const pinned = new Map(source.files.map((file) => [file.relpath, file]))
      const matches =
        manifest.files.length === source.files.length &&
        manifest.files.every((file) => {
          const pin = pinned.get(file.relpath)
          return (
            pin !== undefined &&
            pin.url === file.url &&
            pin.sha256 === file.sha256 &&
            pin.bytes === file.bytes
          )
        })
      if (!matches) return { state: 'corrupt', cached: null }
    }
    for (const file of manifest.files) {
      const info = await lstat(join(folder, file.relpath)).catch(() => null)
      if (!info?.isFile() || info.size !== file.bytes) {
        return { state: 'corrupt', cached: null }
      }
    }
    return {
      state: 'present',
      cached: {
        version: manifest.version,
        retrievedAt: manifest.retrievedAt,
        bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      },
    }
  }

  /** List every source with its cache state. */
  async list(): Promise<AtlasSourcesList> {
    const sources: AtlasSourceListing[] = []
    for (const source of ATLAS_SOURCES) {
      const { state, cached } = await this.cacheState(source)
      sources.push({
        source,
        state,
        cached,
        downloadable: isDownloadable(source),
      })
    }
    return { cacheDisplayPath: this.root(), sources }
  }

  /**
   * Start one download after the operator acknowledged the license. While
   * a download runs, another request returns it with `started` false.
   *
   * @throws Error for an unknown or non-downloadable source.
   */
  async download(request: {
    sourceId: string
    licenseAcknowledged: true
  }): Promise<AtlasDownloadStartResult> {
    const source = ATLAS_SOURCES.find(
      (item) => item.sourceId === request.sourceId,
    )
    if (!source) throw new Error('Choose a listed atlas source.')
    if (!isDownloadable(source)) {
      throw new Error(
        'This atlas source has no verified download; open its page.',
      )
    }
    if (request.licenseAcknowledged !== true) {
      throw new Error('Acknowledge the atlas license before downloading.')
    }
    if (this.operation?.state === 'running') {
      return { operation: { ...this.operation }, started: false }
    }
    const operation: AtlasDownloadOperation = {
      operationId: `adl-${randomBytes(8).toString('hex')}`,
      sourceId: source.sourceId,
      state: 'running',
      receivedBytes: 0,
      totalBytes: source.files.reduce((sum, file) => sum + file.bytes, 0),
      file: null,
      startedAt: this.now(),
      finishedAt: null,
      message: null,
    }
    const controller = new AbortController()
    this.operation = operation
    this.controller = controller
    this.task = this.run(source, operation, controller.signal).finally(() => {
      if (this.controller === controller) this.controller = null
    })
    return { operation: { ...operation }, started: true }
  }

  /** Fetch, verify, and publish every file of one source version. */
  private async run(
    source: AtlasSource,
    operation: AtlasDownloadOperation,
    signal: AbortSignal,
  ): Promise<void> {
    const acknowledgedAt = operation.startedAt
    const parent = join(this.root(), source.sourceId)
    const staging = join(
      parent,
      `${STAGING_PREFIX}${operation.operationId.slice(4)}`,
    )
    const fetchFile: AtlasFetch =
      this.context.fetch ?? ((url, init) => fetch(url, init))
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 })
      for (const folder of [this.root(), parent]) {
        const info = await lstat(folder)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new AtlasDownloadError(
            `${folder} is not a plain folder; remove it and try again.`,
          )
        }
      }
      await this.sweep(parent)
      await mkdir(staging, { mode: 0o700 })
      for (const file of source.files) {
        if (signal.aborted) throw new Error('The atlas download was cancelled.')
        operation.file = file.relpath
        const target = join(staging, file.relpath)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        const response = await fetchFile(file.url, {
          redirect: 'error',
          signal,
        })
        if (response.status !== 200 || response.redirected) {
          await response.body?.cancel().catch(() => undefined)
          throw new AtlasDownloadError(
            `The atlas site answered ${response.status} for ${file.relpath}; try again later.`,
          )
        }
        const handle = await open(target, 'wx', 0o600)
        let written: { bytes: number; sha256: string }
        try {
          written = await writeBody(
            response,
            handle,
            file.bytes,
            signal,
            (count) => {
              operation.receivedBytes += count
            },
          )
          await handle.sync()
        } finally {
          await handle.close().catch(() => undefined)
        }
        if (written.bytes !== file.bytes || written.sha256 !== file.sha256) {
          throw new AtlasDownloadError(
            `${file.relpath} does not match its pinned size and SHA-256; nothing was kept.`,
          )
        }
      }
      operation.file = null
      const manifest: AtlasCacheManifest = {
        schema: ATLAS_CACHE_SCHEMA,
        schemaVersion: 1,
        sourceId: source.sourceId,
        version: source.version,
        provenance: 'downloaded',
        files: source.files.map((file) => ({
          relpath: file.relpath,
          url: file.url,
          sha256: file.sha256,
          bytes: file.bytes,
        })),
        license: {
          name: source.license.name,
          url: source.license.url,
          acknowledgedAt,
        },
        retrievedAt: this.now(),
      }
      const handle = await open(join(staging, ATLAS_MANIFEST_NAME), 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`)
        await handle.sync()
      } finally {
        await handle.close().catch(() => undefined)
      }
      if (signal.aborted) throw new Error('The atlas download was cancelled.')
      await this.publish(staging, this.versionFolder(source), operation)
      operation.state = 'done'
      operation.finishedAt = manifest.retrievedAt
    } catch (error) {
      operation.file = null
      operation.finishedAt = this.now()
      if (signal.aborted) {
        operation.state = 'cancelled'
        operation.message = null
      } else {
        operation.state = 'failed'
        operation.message = downloadMessage(error)
      }
    } finally {
      await removeFolder(staging)
    }
  }

  /** Replace the version folder with the verified staging folder. */
  private async publish(
    staging: string,
    target: string,
    operation: AtlasDownloadOperation,
  ): Promise<void> {
    const retired = join(
      dirname(target),
      `${RETIRED_PREFIX}${operation.operationId.slice(4)}`,
    )
    const existing = await lstat(target).catch(() => null)
    if (existing !== null) await rename(target, retired)
    try {
      await rename(staging, target)
    } catch (error) {
      if (existing !== null)
        await rename(retired, target).catch(() => undefined)
      throw error
    }
    await removeFolder(retired)
  }

  /** Remove staging and retired folders a stopped app left behind. */
  private async sweep(parent: string): Promise<void> {
    const names = await readdir(parent).catch(() => [] as string[])
    for (const name of names) {
      if (name.startsWith(STAGING_PREFIX) || name.startsWith(RETIRED_PREFIX)) {
        await removeFolder(join(parent, name))
      }
    }
  }

  /** Report the running or last download. */
  async status(): Promise<AtlasDownloadStatus> {
    return { operation: this.operation ? { ...this.operation } : null }
  }

  /** Stop the running download; nothing partial is kept. */
  async cancel(request: {
    operationId: string
  }): Promise<AtlasDownloadCancelResult> {
    if (!ATLAS_DOWNLOAD_OPERATION_ID.test(request.operationId)) {
      throw new Error('Provide a valid atlas download operation ID.')
    }
    const operation = this.operation
    if (
      operation === null ||
      operation.operationId !== request.operationId ||
      operation.state !== 'running' ||
      this.controller === null
    ) {
      return { operationId: request.operationId, stopped: false }
    }
    this.controller.abort()
    await this.task?.catch(() => undefined)
    return { operationId: request.operationId, stopped: true }
  }

  /**
   * Open a source's official page or its license, as the catalog lists
   * them.
   *
   * @throws Error for an unknown source or kind.
   */
  async openPage(request: {
    sourceId: string
    kind: AtlasSourceUrlKind
  }): Promise<void> {
    const url = atlasSourceUrl(request.sourceId, request.kind)
    if (url === null) throw new Error('Choose a listed atlas source.')
    await this.context.openExternal(url)
  }

  /** Stop any download, for app shutdown; its staging folder is removed. */
  stopAll(): Promise<void> {
    this.controller?.abort()
    return this.task?.catch(() => undefined) ?? Promise.resolve()
  }
}

/** Turn a download failure into a sentence for the panel. */
function downloadMessage(error: unknown): string {
  return error instanceof AtlasDownloadError
    ? error.message.slice(0, 512)
    : 'The atlas download failed; check the network connection and try again.'
}
