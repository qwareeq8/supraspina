import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { BUNDLED_PACKAGES_SCHEMA } from './bundled-packages.mjs'
import { generateNodeReleaseMetadata } from './generate-node-release-metadata.mjs'
import { createReleasePackageManifest } from './release-package-manifest.mjs'
import { verifyPackagedApplication } from './verify-packaged-application.mjs'

const electronTerms = Buffer.from('Copyright Electron contributors\n')
const chromiumTerms = Buffer.from('<html>Chromium notices</html>\n')
const micromambaFixture = Buffer.from('#!/bin/sh\nexit 0\n')
const execFileAsync = promisify(execFile)
const packageVersion = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version
const cleanGitState = Object.freeze({
  repositoryUrl: 'https://github.com/qwareeq8/supraspina.git',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  changedPaths: [],
})
const fixtureElectronLicenses = [
  {
    name: 'LICENSE.electron.txt',
    bytes: electronTerms.length,
    sha256: createHash('sha256').update(electronTerms).digest('hex'),
  },
  {
    name: 'LICENSES.chromium.html',
    bytes: chromiumTerms.length,
    sha256: createHash('sha256').update(chromiumTerms).digest('hex'),
  },
]

const packageLock = JSON.parse(
  await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
)
// The renderer bundle of the fixture: React, which Vite inlines, on top of
// the production closure.
const rendererBundle = join(
  await mkdtemp(join(tmpdir(), 'supraspina-renderer-bundle-')),
  'bundled-packages.json',
)
await writeFile(
  rendererBundle,
  JSON.stringify({
    schema: BUNDLED_PACKAGES_SCHEMA,
    schemaVersion: 1,
    packages: ['react', 'react-dom', 'scheduler'].map((name) => ({
      name,
      version: packageLock.packages[`node_modules/${name}`].version,
      lockPath: `node_modules/${name}`,
    })),
  }),
)

async function fixture(target = 'linux-x86_64') {
  const applicationRoot = await mkdtemp(join(tmpdir(), 'supraspina-package-'))
  const resourcesPath = join(applicationRoot, 'resources')
  const dependencyDirectory = join(resourcesPath, 'dependency-manifests')
  const runtime = join(resourcesPath, 'sidecar', 'supraspina-runtime')
  await mkdir(join(resourcesPath, 'licenses'), { recursive: true })
  await mkdir(join(runtime, 'metadata'), { recursive: true })
  await mkdir(join(runtime, 'resources', 'step7'), { recursive: true })
  await mkdir(join(runtime, 'resources', 'brainfov'), { recursive: true })
  await mkdir(join(runtime, 'pybrainage-locks'), { recursive: true })
  await mkdir(join(runtime, 'braincharts-locks'), { recursive: true })
  await mkdir(join(resourcesPath, 'micromamba'), { recursive: true })
  const releasePackageManifestContract = await createReleasePackageManifest({
    gitState: cleanGitState,
  })
  await generateNodeReleaseMetadata(dependencyDirectory, {
    gitState: cleanGitState,
    bundledPackagesPath: rendererBundle,
  })
  await mkdir(join(dependencyDirectory, 'python-locks'))
  const nodeManifestPath = join(dependencyDirectory, 'node-distributable.json')
  const nodeManifest = JSON.parse(await readFile(nodeManifestPath, 'utf8'))
  nodeManifest.electronRuntimeLicenses = fixtureElectronLicenses
  await writeFile(nodeManifestPath, JSON.stringify(nodeManifest))

  for (const name of [
    'LICENSE',
    'THIRD_PARTY_NOTICES',
    'THIRD_PARTY_PROVENANCE.json',
    'licenses/FreeSurfer-Software-License-1.0.txt',
    'licenses/GPL-3.0.txt',
    'licenses/GUST-FONT-LICENSE.txt',
    'licenses/Lucide-ISC.txt',
    'licenses/MANIFEST-LM-Roman-Supraspina.txt',
    'licenses/micromamba-BSD-3-Clause.txt',
  ]) {
    await cp(new URL(`../${name}`, import.meta.url), join(resourcesPath, name))
  }
  await cp(
    new URL('../THIRD_PARTY_PROVENANCE.json', import.meta.url),
    join(runtime, 'metadata', 'THIRD_PARTY_PROVENANCE.json'),
  )
  const provenance = JSON.parse(
    await readFile(
      new URL('../THIRD_PARTY_PROVENANCE.json', import.meta.url),
      'utf8',
    ),
  )
  for (const [relativePath, record] of Object.entries(
    provenance.resourceFiles,
  )) {
    if (record.delivery !== 'bundled') continue
    const destination = join(runtime, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await cp(new URL(`../${relativePath}`, import.meta.url), destination)
  }
  await cp(
    new URL('../SCIENTIFIC_RESOURCE_PINS.json', import.meta.url),
    join(runtime, 'metadata', 'SCIENTIFIC_RESOURCE_PINS.json'),
  )
  await cp(
    new URL('../sidecar/supraspina_sidecar/brainfov.py', import.meta.url),
    join(runtime, 'resources', 'brainfov', 'brainfov_helper.py'),
  )
  for (const name of [
    'cliffs-delta-requirements.txt',
    'pybrainage-linux-64.lock',
  ]) {
    await cp(
      new URL(
        `../sidecar/supraspina_sidecar/pybrainage_locks/${name}`,
        import.meta.url,
      ),
      join(runtime, 'pybrainage-locks', name),
    )
  }
  for (const name of [
    'braincharts-linux-64.lock',
    'braincharts-requirements.txt',
  ]) {
    await cp(
      new URL(
        `../sidecar/supraspina_sidecar/braincharts_locks/${name}`,
        import.meta.url,
      ),
      join(runtime, 'braincharts-locks', name),
    )
  }
  for (const name of ['sidecar/supraspina-sidecar', 'micromamba/micromamba']) {
    const path = join(resourcesPath, name)
    await writeFile(path, micromambaFixture)
    await chmod(path, 0o755)
  }
  const pythonLock = await readFile(
    new URL(`../sidecar/requirements/release-${target}.txt`, import.meta.url),
  )
  const components = [
    ...pythonLock
      .toString('utf8')
      .matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\/gm),
  ].map(([, name, version]) => ({ name, version }))
  await writeFile(
    join(dependencyDirectory, `python-release-${target}.cyclonedx.json`),
    JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      metadata: {
        component: {
          type: 'application',
          name: 'Supraspina frozen Python sidecar',
          version: packageVersion,
        },
        properties: [
          { name: 'supraspina:target', value: target },
          { name: 'supraspina:python', value: '3.12.10' },
          {
            name: 'supraspina:lock-sha256',
            value: createHash('sha256').update(pythonLock).digest('hex'),
          },
        ],
      },
      components,
    }),
  )
  await cp(
    new URL('../sidecar/requirements/release-toolchain.json', import.meta.url),
    join(dependencyDirectory, 'python-locks', 'release-toolchain.json'),
  )
  await writeFile(
    join(dependencyDirectory, `python-release-${target}-notices.txt`),
    'sanitized metadata\n',
  )
  await cp(
    new URL('../package-lock.json', import.meta.url),
    join(dependencyDirectory, 'package-lock.json'),
  )
  await cp(
    new URL(`../sidecar/requirements/release-${target}.txt`, import.meta.url),
    join(dependencyDirectory, 'python-locks', `release-${target}.txt`),
  )
  const electronLicenseDirectory = applicationRoot
  await mkdir(electronLicenseDirectory, { recursive: true })
  await writeFile(
    join(electronLicenseDirectory, 'LICENSE.electron.txt'),
    electronTerms,
  )
  await writeFile(
    join(electronLicenseDirectory, 'LICENSES.chromium.html'),
    chromiumTerms,
  )
  return {
    applicationRoot,
    resourcesPath,
    runtime,
    dependencyDirectory,
    electronLicenseContract: fixtureElectronLicenses,
    micromambaSha256Contract: {
      'linux-x86_64': createHash('sha256')
        .update(micromambaFixture)
        .digest('hex'),
    },
    pythonPackageCount: components.length,
    releasePackageManifestContract,
  }
}

test('verifies complete packaged notices and excludes unresolved assets', async () => {
  const paths = await fixture()
  const result = await verifyPackagedApplication({
    ...paths,
    target: 'linux-x86_64',
  })

  assert.deepEqual(result, {
    target: 'linux-x86_64',
    publicNoticeFiles: 9,
    nodePackages: 22,
    pythonPackages: paths.pythonPackageCount,
    chromiumLicenseFiles: 1,
  })
})

test('validates CLI arguments through an alternate symlink spelling', async () => {
  const linkDirectory = await mkdtemp(
    join(tmpdir(), 'supraspina-package-verifier-link-'),
  )
  const verifierLink = join(linkDirectory, 'verify-packaged-application.mjs')
  await symlink(
    new URL('./verify-packaged-application.mjs', import.meta.url),
    verifierLink,
  )

  await assert.rejects(
    execFileAsync(process.execPath, [verifierLink]),
    /Use verify-packaged-application\.mjs/,
  )
})

test('rejects every unsupported non-Linux package target', async () => {
  const paths = await fixture()

  for (const target of ['macos-arm64', 'win32-x64', 'linux-arm64']) {
    await assert.rejects(
      verifyPackagedApplication({ ...paths, target }),
      /Use a supported package target/,
    )
  }
})

test('fails when an unresolved upstream binary appears in staging', async () => {
  const paths = await fixture()
  const forbidden = join(
    paths.runtime,
    'resources',
    'enigma',
    'compiled',
    'FS_external_QC',
  )
  await mkdir(join(forbidden, '..'), { recursive: true })
  await writeFile(forbidden, 'must not ship')

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Remove the unlicensed upstream asset from redistribution/,
  )
})

test('fails when scientific acquisition metadata differs from reviewed source', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.runtime, 'metadata', 'SCIENTIFIC_RESOURCE_PINS.json'),
    '{"schemaVersion":1}\n',
  )

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Match the byte size for scientific resource pin manifest/,
  )
})

test('fails when packaged public terms differ from reviewed source', async () => {
  const paths = await fixture()
  const noticePath = join(paths.resourcesPath, 'THIRD_PARTY_NOTICES')
  const notices = await readFile(noticePath)
  notices[0] ^= 1
  await writeFile(noticePath, notices)

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /Match the SHA-256 for THIRD_PARTY_NOTICES/,
  )
})

test('fails when the frozen provenance copy differs from reviewed source', async () => {
  const paths = await fixture()
  const provenancePath = join(
    paths.runtime,
    'metadata',
    'THIRD_PARTY_PROVENANCE.json',
  )
  const provenance = await readFile(provenancePath)
  provenance[0] ^= 1
  await writeFile(provenancePath, provenance)

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /Match the SHA-256 for frozen-sidecar acquisition metadata/,
  )
})

test('fails when package staging contains an unexpected public license', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.resourcesPath, 'licenses', 'unexpected.txt'),
    'unexpected',
  )

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /exact public license directory entries/,
  )
})

test('fails when dependency staging contains an unexpected file', async () => {
  const paths = await fixture()
  await writeFile(join(paths.dependencyDirectory, 'unexpected.json'), '{}\n')

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /exact dependency-manifest directory entries/,
  )
})

test('fails when the packaged source identity or signing decision changes', async () => {
  const paths = await fixture()
  const manifestPath = join(
    paths.dependencyDirectory,
    'release-package-manifest.json',
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.source.commit = 'c'.repeat(40)
  await writeFile(manifestPath, JSON.stringify(manifest))

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /exact release package manifest to this source/,
  )

  manifest.source.commit = paths.releasePackageManifestContract.source.commit
  manifest.signing.decision = 'signed'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /exact release package manifest to this source/,
  )
})

test('fails when frozen-sidecar staging contains an unexpected sibling', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.resourcesPath, 'sidecar', 'unexpected.txt'),
    'unexpected',
  )

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /exact frozen-sidecar directory entries/,
  )
})

test('fails when the packaged brain-FOV helper differs from source', async () => {
  const paths = await fixture()
  const helperPath = join(
    paths.runtime,
    'resources',
    'brainfov',
    'brainfov_helper.py',
  )
  const helper = await readFile(helperPath)
  helper[0] ^= 1
  await writeFile(helperPath, helper)

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Match the SHA-256 for brain-FOV helper/,
  )
})

test('fails when a frozen PyBrainAge lock differs from source', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.runtime, 'pybrainage-locks', 'cliffs-delta-requirements.txt'),
    'stale lock\n',
  )

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /frozen PyBrainAge lock cliffs-delta-requirements\.txt/,
  )
})

test('fails when a frozen BrainCharts lock differs from source', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.runtime, 'braincharts-locks', 'braincharts-requirements.txt'),
    'stale lock\n',
  )

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /frozen BrainCharts lock braincharts-requirements\.txt/,
  )
})

test('fails when the frozen BrainCharts lock directory holds an extra file', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.runtime, 'braincharts-locks', 'unreviewed.txt'),
    'extra\n',
  )

  await assert.rejects(
    verifyPackagedApplication({ ...paths, target: 'linux-x86_64' }),
    /frozen BrainCharts lock directory/,
  )
})

test('fails when a managed SIF appears in the installer payload', async () => {
  const paths = await fixture()
  const managedResource = join(
    paths.resourcesPath,
    'scientific-resources',
    'fastsurfer',
    'fastsurfer.sif',
  )
  await mkdir(join(managedResource, '..'), { recursive: true })
  await writeFile(managedResource, 'must remain in userData')

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Remove managed scientific resources from the bundle/,
  )
})

test('fails when the packaged micromamba digest differs from provenance', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.resourcesPath, 'micromamba', 'micromamba'),
    '#!/bin/sh\nexit 1\n',
  )

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Match the SHA-256 for bundled micromamba/,
  )
})

test('fails when user-supplied FreeSurfer activation material is packaged', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.runtime, 'license.txt'),
    'user-supplied activation material',
  )

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Remove the user-supplied FreeSurfer license from the bundle/,
  )
})

test('fails when a Node package is neither shipped nor bundled', async () => {
  const paths = await fixture()
  const nodeManifestPath = join(
    paths.dependencyDirectory,
    'node-distributable.json',
  )
  const nodeManifest = JSON.parse(await readFile(nodeManifestPath, 'utf8'))
  const react = nodeManifest.packages.find((record) => record.name === 'react')
  react.bundledInRenderer = false
  await writeFile(nodeManifestPath, JSON.stringify(nodeManifest))

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Complete the Node distributable manifest/,
  )
})

test('fails when packaged dependency metadata names a stale product version', async () => {
  const paths = await fixture()
  const nodeManifestPath = join(
    paths.dependencyDirectory,
    'node-distributable.json',
  )
  const nodeManifest = JSON.parse(await readFile(nodeManifestPath, 'utf8'))
  nodeManifest.packageVersion = '20000101.0.0'
  await writeFile(nodeManifestPath, JSON.stringify(nodeManifest))

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Complete the Node distributable manifest/,
  )
})

test('fails when packaged Python metadata names a stale runtime', async () => {
  const paths = await fixture()
  const sbomPath = join(
    paths.dependencyDirectory,
    'python-release-linux-x86_64.cyclonedx.json',
  )
  const sbom = JSON.parse(await readFile(sbomPath, 'utf8'))
  const python = sbom.metadata.properties.find(
    (property) => property.name === 'supraspina:python',
  )
  python.value = '3.12.9'
  await writeFile(sbomPath, JSON.stringify(sbom))

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Complete the Python release SBOM/,
  )
})

test('fails when packaged Chromium terms disagree with the manifest', async () => {
  const paths = await fixture()
  await writeFile(
    join(paths.applicationRoot, 'LICENSES.chromium.html'),
    Buffer.alloc(chromiumTerms.length, 0),
  )

  await assert.rejects(
    verifyPackagedApplication({
      ...paths,
      target: 'linux-x86_64',
    }),
    /Match the SHA-256/,
  )
})
