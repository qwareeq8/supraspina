import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BUNDLED_PACKAGES_SCHEMA } from './bundled-packages.mjs'
import {
  electronRuntimeLicenseContract,
  generateNodeReleaseMetadata,
  nodeReleaseMetadataNames,
  reviewedLicenseTexts,
} from './generate-node-release-metadata.mjs'

const cleanGitState = Object.freeze({
  repositoryUrl: 'https://github.com/qwareeq8/supraspina.git',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  changedPaths: [],
})

const lock = JSON.parse(
  await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
)

/** Write a renderer bundled-packages record naming these lock paths. */
async function bundledRecord(lockPaths, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'supraspina-bundled-'))
  const path = join(directory, 'bundled-packages.json')
  const packages = lockPaths.map((lockPath) => ({
    name: lockPath.replace(/^node_modules\//, ''),
    version: lock.packages[lockPath].version,
    lockPath,
    ...overrides,
  }))
  await writeFile(
    path,
    JSON.stringify({
      schema: BUNDLED_PACKAGES_SCHEMA,
      schemaVersion: 1,
      packages,
    }),
  )
  return path
}

const rendererBundle = await bundledRecord([
  'node_modules/@niivue/niivue',
  'node_modules/react',
  'node_modules/react-dom',
  'node_modules/scheduler',
  'node_modules/zod',
])

test('Node distributable manifest includes production closure and Electron', async () => {
  const output = await mkdtemp(join(tmpdir(), 'supraspina-node-metadata-'))
  const manifest = await generateNodeReleaseMetadata(output, {
    gitState: cleanGitState,
    bundledPackagesPath: rendererBundle,
  })
  const names = new Set(manifest.packages.map((item) => item.name))

  assert.equal(manifest.embeddedElectron, '42.11.18')
  assert.deepEqual(
    manifest.electronRuntimeLicenses,
    electronRuntimeLicenseContract.map(({ name, bytes, sha256 }) => ({
      name,
      bytes,
      sha256,
    })),
  )
  assert(names.has('electron'))
  assert(names.has('electron-log'))
  assert(names.has('electron-updater'))
  assert(names.has('zod'))
  assert.equal(
    manifest.packages.filter((item) => item.embeddedRuntime).length,
    1,
  )
  assert(
    manifest.packages.every((item) =>
      /^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity),
    ),
  )

  const sbom = JSON.parse(
    await readFile(join(output, 'node-distributable.cyclonedx.json'), 'utf8'),
  )
  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.equal(sbom.specVersion, '1.6')
  assert.equal(sbom.metadata.component.version, manifest.packageVersion)
  assert.equal(sbom.components.length, manifest.packages.length)
  assert(
    sbom.components.some(
      (component) =>
        component.name === 'electron' && component.version === '42.11.18',
    ),
  )

  const notices = await readFile(
    join(output, 'node-third-party-notices.txt'),
    'utf8',
  )
  assert.match(notices, /Electron Community/)
  assert.match(notices, /lazy-val 1\.0\.5/)
  assert(!notices.includes(process.cwd()))

  // Renderer-bundled packages carry their license texts too, including
  // NiiVue, whose tarball ships no LICENSE file.
  const byName = new Map(manifest.packages.map((item) => [item.name, item]))
  for (const name of ['react', 'react-dom', 'scheduler', '@niivue/niivue']) {
    assert.equal(byName.get(name)?.bundledInRenderer, true, name)
    assert.equal(byName.get(name)?.production, false, name)
  }
  assert.equal(byName.get('zod')?.production, true)
  assert.equal(byName.get('zod')?.bundledInRenderer, true)
  assert.equal(byName.get('electron-log')?.bundledInRenderer, false)
  assert.equal(
    manifest.packages.filter((item) => item.production || item.embeddedRuntime)
      .length,
    19,
  )
  assert.deepEqual(
    byName.get('@niivue/niivue')?.licenseFiles.map((file) => file.sha256),
    [reviewedLicenseTexts['@niivue/niivue@0.69.0'].sha256],
  )
  assert.match(
    notices,
    /react 19\.2\.6\n-+\nDeclared license: MIT\nBundled into the renderer by Vite\./,
  )
  assert.match(notices, /Copyright \(c\) 2021, Niivue/)
  assert.match(
    notices,
    /Copyright \(c\) Meta Platforms, Inc\. and affiliates\./,
  )
  assert(
    sbom.components.some(
      (component) =>
        component.name === '@niivue/niivue' &&
        component.properties.some(
          (property) =>
            property.name === 'supraspina:bundled-in-renderer' &&
            property.value === 'true',
        ),
    ),
  )

  assert.deepEqual(
    (await readdir(output)).sort(),
    [...nodeReleaseMetadataNames].sort(),
  )
  const packageManifest = JSON.parse(
    await readFile(join(output, 'release-package-manifest.json'), 'utf8'),
  )
  assert.equal(packageManifest.source.commit, 'a'.repeat(40))
  assert.equal(packageManifest.source.clean, true)
  assert.equal(packageManifest.signing.decision, 'unsigned')
})

test('Node release metadata refuses stale ignored staging', async () => {
  const output = await mkdtemp(
    join(tmpdir(), 'supraspina-node-metadata-stale-'),
  )
  await writeFile(join(output, 'stale.json'), '{}\n')

  await assert.rejects(
    generateNodeReleaseMetadata(output, {
      gitState: cleanGitState,
      bundledPackagesPath: rendererBundle,
    }),
    /empty Node release-metadata destination; found: stale\.json/,
  )
})

test('Node release metadata requires the renderer bundle record', async () => {
  const output = await mkdtemp(
    join(tmpdir(), 'supraspina-node-metadata-nobundle-'),
  )

  await assert.rejects(
    generateNodeReleaseMetadata(output, {
      gitState: cleanGitState,
      bundledPackagesPath: join(output, 'missing', 'bundled-packages.json'),
    }),
    /Build the renderer before generating Node release metadata/,
  )
})

test('Node release metadata refuses a bundled package outside the lock', async () => {
  const output = await mkdtemp(
    join(tmpdir(), 'supraspina-node-metadata-drift-'),
  )
  const drifted = await bundledRecord(['node_modules/react'], {
    version: '0.0.0',
  })

  await assert.rejects(
    generateNodeReleaseMetadata(output, {
      gitState: cleanGitState,
      bundledPackagesPath: drifted,
    }),
    /Match the bundled renderer package to package-lock: node_modules\/react/,
  )
})
