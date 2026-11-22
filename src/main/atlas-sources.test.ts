import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AtlasSource } from '../shared/atlas-labeling'

const BASE = 'https://raw.githubusercontent.com/example/atlas/0123abcd'
const LICENSE_TEXT = 'MIT License\n'
const ANNOT_TEXT = 'annotation bytes'

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const hoisted = vi.hoisted(() => ({ sources: [] as AtlasSource[] }))

vi.mock('../shared/atlas-labeling', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../shared/atlas-labeling')>()
  return { ...actual, ATLAS_SOURCES: hoisted.sources }
})

function source(overrides: Partial<AtlasSource> = {}): AtlasSource {
  return {
    sourceId: 'test-atlas',
    label: 'Test atlas',
    kind: 'surface',
    site: 'GitHub',
    pageUrl: 'https://github.com/example/atlas',
    license: { name: 'MIT', url: 'https://github.com/example/atlas/LICENSE' },
    citation: 'Example A. An atlas. 2026.',
    version: 'v1',
    files: [
      {
        url: `${BASE}/LICENSE`,
        sha256: sha(LICENSE_TEXT),
        bytes: LICENSE_TEXT.length,
        relpath: 'LICENSE',
      },
      {
        url: `${BASE}/label/lh.test.annot`,
        sha256: sha(ANNOT_TEXT),
        bytes: ANNOT_TEXT.length,
        relpath: 'fsaverage/label/lh.test.annot',
      },
    ],
    requiresLogin: false,
    atlasIds: ['test-atlas'],
    hemisphereRules: ['lh-rh-underscore-infix'],
    recipeId: 'user-annot',
    ...overrides,
  }
}

let root: string
let cache: string
let bodies: Map<string, () => Response>

function servedFetch() {
  return vi.fn(async (url: string, init: { signal: AbortSignal }) => {
    if (init.signal.aborted) throw new Error('aborted')
    const make = bodies.get(url)
    if (!make) return new Response('missing', { status: 404 })
    return make()
  })
}

async function manager(fetch = servedFetch()) {
  const { AtlasSourceManager } = await import('./atlas-sources')
  const openExternal = vi.fn(async () => undefined)
  const instance = new AtlasSourceManager({
    userDataPath: root,
    openExternal,
    fetch,
    now: () => new Date('2026-09-30T12:00:00.000Z'),
  })
  return { instance, fetch, openExternal }
}

async function settled(instance: {
  status: () => Promise<{ operation: { state: string } | null }>
}) {
  await vi.waitFor(async () => {
    const { operation } = await instance.status()
    expect(operation?.state).not.toBe('running')
  })
  return (await instance.status()).operation
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'supraspina-atlas-sources-'))
  cache = join(root, 'atlases')
  hoisted.sources.splice(
    0,
    hoisted.sources.length,
    source(),
    source({
      sourceId: 'login-atlas',
      files: [],
      requiresLogin: true,
      version: 'unverified',
    }),
    source({
      sourceId: 'elsewhere-atlas',
      files: [{ ...source().files[0]!, url: 'https://example.com/LICENSE' }],
    }),
  )
  bodies = new Map([
    [`${BASE}/LICENSE`, () => new Response(LICENSE_TEXT)],
    [`${BASE}/label/lh.test.annot`, () => new Response(ANNOT_TEXT)],
  ])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('allowed download URLs', () => {
  it('accepts only plain https URLs on the allowlisted host', async () => {
    const { isAllowedAtlasDownload } = await import('./atlas-sources')
    expect(isAllowedAtlasDownload(`${BASE}/LICENSE`)).toBe(true)
    for (const url of [
      'http://raw.githubusercontent.com/example/LICENSE',
      'https://example.com/LICENSE',
      'https://raw.githubusercontent.com:8443/example/LICENSE',
      'https://user@raw.githubusercontent.com/example/LICENSE',
      'https://raw.githubusercontent.com/example/LICENSE?x=1',
      'https://raw.githubusercontent.com/example/LICENSE#top',
      'https://raw.githubusercontent.com/a/../b',
      'not a url',
    ]) {
      expect(isAllowedAtlasDownload(url)).toBe(false)
    }
  })
})

describe('listing atlas sources', () => {
  it('lists each source as absent and downloadable only when fully pinned', async () => {
    const { instance } = await manager()
    const listed = await instance.list()
    expect(listed.cacheDisplayPath).toBe(cache)
    expect(
      listed.sources.map((item) => [
        item.source.sourceId,
        item.state,
        item.downloadable,
      ]),
    ).toEqual([
      ['test-atlas', 'absent', true],
      ['login-atlas', 'absent', false],
      ['elsewhere-atlas', 'absent', false],
    ])
  })

  it('reports a damaged cache as corrupt and an imported one as present', async () => {
    const { instance } = await manager()
    await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    await settled(instance)
    const folder = join(cache, 'test-atlas', 'v1')
    const state = async () =>
      (await instance.list()).sources[0]!.state as string
    expect(await state()).toBe('present')

    await writeFile(join(folder, 'LICENSE'), 'a longer license text')
    expect(await state()).toBe('corrupt')
    await writeFile(join(folder, 'LICENSE'), LICENSE_TEXT)

    const manifestPath = join(folder, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, files: manifest.files.slice(1) }),
    )
    expect(await state()).toBe('corrupt')
    await writeFile(manifestPath, JSON.stringify({ ...manifest, extra: 1 }))
    expect(await state()).toBe('corrupt')
    await writeFile(manifestPath, '{')
    expect(await state()).toBe('corrupt')

    // An imported copy is checked for its files, not against the pins.
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        provenance: 'imported',
        files: [{ ...manifest.files[0], url: null }],
      }),
    )
    expect(await state()).toBe('present')

    await rm(manifestPath)
    await writeFile(join(root, 'elsewhere.json'), JSON.stringify(manifest))
    await symlink(join(root, 'elsewhere.json'), manifestPath)
    expect(await state()).toBe('corrupt')
  })
})

describe('downloading an atlas source', () => {
  it('fetches, verifies, and publishes the files with a manifest', async () => {
    const { instance, fetch } = await manager()
    const started = await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    expect(started.started).toBe(true)
    expect(started.operation).toMatchObject({
      sourceId: 'test-atlas',
      state: 'running',
      receivedBytes: 0,
      totalBytes: LICENSE_TEXT.length + ANNOT_TEXT.length,
    })
    expect(started.operation.operationId).toMatch(/^adl-[a-f0-9]{16}$/)
    const done = await settled(instance)
    const { parseAtlasDownloadStatus, parseAtlasDownloadStartResult } =
      await import('../shared/atlas-labeling')
    expect(parseAtlasDownloadStartResult(started)).toEqual(started)
    expect(parseAtlasDownloadStatus({ operation: done })).toEqual({
      operation: done,
    })
    expect(done).toMatchObject({
      state: 'done',
      receivedBytes: LICENSE_TEXT.length + ANNOT_TEXT.length,
      file: null,
      finishedAt: '2026-09-30T12:00:00.000Z',
      message: null,
    })
    for (const call of fetch.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: 'error' })
    }
    const folder = join(cache, 'test-atlas', 'v1')
    expect(await readFile(join(folder, 'LICENSE'), 'utf8')).toBe(LICENSE_TEXT)
    expect(
      await readFile(join(folder, 'fsaverage/label/lh.test.annot'), 'utf8'),
    ).toBe(ANNOT_TEXT)
    expect((await stat(join(folder, 'LICENSE'))).mode & 0o777).toBe(0o600)
    expect(
      JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')),
    ).toEqual({
      schema: 'supraspina/atlas-source-cache',
      schemaVersion: 1,
      sourceId: 'test-atlas',
      version: 'v1',
      provenance: 'downloaded',
      files: source().files.map(({ relpath, url, sha256, bytes }) => ({
        relpath,
        url,
        sha256,
        bytes,
      })),
      license: {
        name: 'MIT',
        url: 'https://github.com/example/atlas/LICENSE',
        acknowledgedAt: '2026-09-30T12:00:00.000Z',
      },
      retrievedAt: '2026-09-30T12:00:00.000Z',
    })
    expect(await readdir(join(cache, 'test-atlas'))).toEqual(['v1'])
    const listed = await instance.list()
    expect(listed.sources[0]).toMatchObject({
      state: 'present',
      cached: {
        version: 'v1',
        retrievedAt: '2026-09-30T12:00:00.000Z',
        bytes: LICENSE_TEXT.length + ANNOT_TEXT.length,
      },
    })
  })

  it('replaces an earlier copy and sweeps folders a stopped app left', async () => {
    const { instance } = await manager()
    await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    await settled(instance)
    await mkdir(join(cache, 'test-atlas', '.staging-0000000000000000'))
    await mkdir(join(cache, 'test-atlas', '.retired-0000000000000000'))
    await writeFile(join(cache, 'test-atlas', 'v1', 'stray'), 'old')
    await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    expect((await settled(instance))?.state).toBe('done')
    expect(await readdir(join(cache, 'test-atlas'))).toEqual(['v1'])
    expect(
      await lstat(join(cache, 'test-atlas', 'v1', 'stray')).catch(() => null),
    ).toBeNull()
  })

  it.each([
    [
      'a digest mismatch',
      () => new Response('annotation BYTES'),
      /does not match its pinned size and SHA-256/,
    ],
    [
      'a larger body',
      () => new Response(`${ANNOT_TEXT}!`),
      /larger than its pinned size/,
    ],
    [
      'a shorter body',
      () => new Response('annotation'),
      /does not match its pinned size/,
    ],
    [
      'an HTTP error',
      () => new Response('gone', { status: 404 }),
      /answered 404 for fsaverage\/label\/lh.test.annot/,
    ],
  ])('fails on %s and keeps nothing', async (_name, make, message) => {
    bodies.set(`${BASE}/label/lh.test.annot`, make)
    const { instance } = await manager()
    await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    const failed = await settled(instance)
    expect(failed).toMatchObject({ state: 'failed', file: null })
    expect(failed && 'message' in failed ? failed.message : '').toMatch(message)
    expect(await readdir(join(cache, 'test-atlas'))).toEqual([])
  })

  it('refuses a redirected response and hides network details', async () => {
    const redirected = new Response(ANNOT_TEXT)
    Object.defineProperty(redirected, 'redirected', { value: true })
    bodies.set(`${BASE}/label/lh.test.annot`, () => redirected)
    const first = await manager()
    await first.instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    expect(await settled(first.instance)).toMatchObject({ state: 'failed' })

    const second = await manager(
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND secret.internal')
      }),
    )
    await second.instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    expect(await settled(second.instance)).toMatchObject({
      state: 'failed',
      message:
        'The atlas download failed; check the network connection and try again.',
    })
  })

  it('cancels a running download, keeps nothing, and reports one at a time', async () => {
    let release: () => void = () => undefined
    const stalled = new Promise<void>((resolve) => {
      release = resolve
    })
    bodies.set(`${BASE}/label/lh.test.annot`, () => {
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(new TextEncoder().encode('annotation'))
          await stalled
          controller.close()
        },
      })
      return new Response(stream)
    })
    const { instance } = await manager()
    const started = await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    await vi.waitFor(async () => {
      const { operation } = await instance.status()
      expect(operation?.file).toBe('fsaverage/label/lh.test.annot')
      expect(operation?.receivedBytes).toBeGreaterThan(LICENSE_TEXT.length)
    })
    const again = await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    expect(again).toMatchObject({
      started: false,
      operation: { operationId: started.operation.operationId },
    })
    await expect(
      instance.cancel({ operationId: 'adl-0000000000000000' }),
    ).resolves.toEqual({ operationId: 'adl-0000000000000000', stopped: false })
    const cancelling = instance.cancel({
      operationId: started.operation.operationId,
    })
    release()
    await expect(cancelling).resolves.toEqual({
      operationId: started.operation.operationId,
      stopped: true,
    })
    expect((await instance.status()).operation).toMatchObject({
      state: 'cancelled',
      message: null,
    })
    expect(await readdir(join(cache, 'test-atlas'))).toEqual([])
    await expect(
      instance.cancel({ operationId: started.operation.operationId }),
    ).resolves.toMatchObject({ stopped: false })
  })

  it('stops a running download at shutdown', async () => {
    bodies.set(
      `${BASE}/LICENSE`,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => undefined),
          }),
        ),
    )
    const { instance } = await manager()
    await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    await vi.waitFor(async () => {
      expect((await instance.status()).operation?.file).toBe('LICENSE')
    })
    await instance.stopAll()
    expect((await instance.status()).operation?.state).toBe('cancelled')
    expect(await readdir(join(cache, 'test-atlas'))).toEqual([])
  })

  it('refuses unknown, unpinned, and unacknowledged downloads', async () => {
    const { instance, fetch } = await manager()
    await expect(
      instance.download({ sourceId: 'other', licenseAcknowledged: true }),
    ).rejects.toThrow(/listed atlas source/)
    for (const sourceId of ['login-atlas', 'elsewhere-atlas']) {
      await expect(
        instance.download({ sourceId, licenseAcknowledged: true }),
      ).rejects.toThrow(/no verified download/)
    }
    await expect(
      instance.download({
        sourceId: 'test-atlas',
        licenseAcknowledged: false as true,
      }),
    ).rejects.toThrow(/Acknowledge the atlas license/)
    await expect(
      instance.cancel({ operationId: 'alb-0000000000000000' }),
    ).rejects.toThrow(/download operation ID/)
    expect(fetch).not.toHaveBeenCalled()
    expect(await instance.status()).toEqual({ operation: null })
  })

  it('refuses a cache folder that is a link', async () => {
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    await symlink(elsewhere, cache)
    const { instance } = await manager()
    await instance.download({
      sourceId: 'test-atlas',
      licenseAcknowledged: true,
    })
    expect(await settled(instance)).toMatchObject({
      state: 'failed',
      message: expect.stringMatching(/not a plain folder/),
    })
    expect(await readdir(elsewhere)).toEqual(['test-atlas'])
  })
})

describe('opening a source page', () => {
  it('opens only a listed source page', async () => {
    hoisted.sources.splice(0, hoisted.sources.length)
    const actual = await vi.importActual<
      typeof import('../shared/atlas-labeling')
    >('../shared/atlas-labeling')
    hoisted.sources.push(...actual.ATLAS_SOURCES)
    const { instance, openExternal } = await manager()
    await instance.openPage({ sourceId: 'brainstem-navigator', kind: 'page' })
    expect(openExternal).toHaveBeenCalledWith(
      'https://www.nitrc.org/projects/brainstemnavig/',
    )
    await instance.openPage({ sourceId: 'schaefer2018', kind: 'license' })
    expect(openExternal).toHaveBeenLastCalledWith(
      'https://github.com/ThomasYeoLab/CBIG/blob/master/LICENSE.md',
    )
    await expect(
      instance.openPage({ sourceId: 'elsewhere', kind: 'page' }),
    ).rejects.toThrow(/listed atlas source/)
    await expect(
      instance.openPage({
        sourceId: 'schaefer2018',
        kind: 'citation' as 'page',
      }),
    ).rejects.toThrow(/listed atlas source/)
    expect(openExternal).toHaveBeenCalledTimes(2)
  })
})

describe('the shipped catalog', () => {
  it('pins Schaefer 2018 as the only download, on the allowlisted host', async () => {
    const actual = await vi.importActual<
      typeof import('../shared/atlas-labeling')
    >('../shared/atlas-labeling')
    hoisted.sources.splice(0, hoisted.sources.length, ...actual.ATLAS_SOURCES)
    const { instance } = await manager()
    const listed = await instance.list()
    // The preload's parser accepts the listing as sent.
    expect(actual.parseAtlasSourcesList(listed)).toEqual(listed)
    expect(
      listed.sources
        .filter((item) => item.downloadable)
        .map((item) => item.source.sourceId),
    ).toEqual(['schaefer2018'])
    const schaefer = actual.ATLAS_SOURCES.find(
      (item) => item.sourceId === 'schaefer2018',
    )!
    expect(schaefer.files).toHaveLength(13)
    expect(schaefer.atlasIds).toHaveLength(6)
    for (const atlasId of schaefer.atlasIds) {
      const [, parcels, networks] = /^schaefer(\d+)-(\d+)$/.exec(atlasId)!
      for (const hemi of ['lh', 'rh']) {
        expect(schaefer.files.map((file) => file.relpath)).toContain(
          `fsaverage/label/${hemi}.Schaefer2018_${parcels}Parcels_${networks}Networks_order.annot`,
        )
      }
    }
    expect(
      schaefer.files.reduce((sum, file) => sum + file.bytes, 0),
    ).toBeLessThan(20 * 1024 * 1024)
  })
})
