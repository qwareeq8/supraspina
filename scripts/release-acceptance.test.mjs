import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'

import {
  ACCEPTANCE_FILE,
  BUILD_COMMAND_IDS,
  BUILD_MAMBA_ENVIRONMENT,
  RELEASE_COMMAND_INPUTS,
  coreReleaseAssetNames,
  createMergedReleaseAcceptance,
  createNativeBuildRecord,
  createNativeHostRecord,
  parseBuildCommandResultOptions,
  validateNativeHost,
  verifyNativeTransfer,
  verifyPublishedAcceptance,
} from './release-acceptance.mjs'
import { releasePackageInputPaths } from './release-package-manifest.mjs'

const temporaryDirectories = []
const version = '20261121.1830.0'
const acceptanceSchema = JSON.parse(
  await readFile(
    new URL('./release-acceptance.schema.json', import.meta.url),
    'utf8',
  ),
)
const validateSchema = new Ajv2020({ allErrors: true }).compile(
  acceptanceSchema,
)
const passedResults = Object.freeze({
  debSmoke: 'passed',
  appImageSmoke: 'passed',
  packageInspection: 'passed',
  debNormalLaunch: 'passed',
  appImageNormalLaunch: 'passed',
  pybrainageProvisioning: 'passed',
  pybrainageReadiness: 'passed',
  syntheticOutputReopen: 'passed',
})
const tools = Object.freeze({
  node: 'v22.13.1',
  npm: '10.9.2',
  bash: 'GNU bash, version 5.2.21(1)-release',
  dpkg: 'Debian dpkg package management program version 1.22.6 (amd64).',
  apt: 'apt 2.7.14 (amd64)',
  file: 'file-5.45',
  xvfbPackage: '2:21.1.12-1ubuntu1',
  fusePackage: '1:2.9.9-6build1',
})
const buildTools = Object.freeze({
  node: 'v22.13.1',
  npm: '10.9.2',
  python: '3.12.10',
  pip: '26.2.1',
  bash: 'GNU bash, version 5.2.21(1)-release',
  curl: 'curl 8.5.0',
  sha256sum: 'sha256sum (GNU coreutils) 9.4',
  file: 'file-5.45',
  dpkgDeb: 'Debian dpkg-deb package archive backend version 1.22.6 (amd64).',
  glibc: 'ldd (Ubuntu GLIBC 2.39-0ubuntu8.4) 2.39',
  electron: '42.11.18',
  electronBuilder: '26.15.3',
  electronVite: '5.0.0',
  pyinstaller: '6.21.0',
  micromamba: '2.7.0',
})
const sourceState = Object.freeze({
  repositoryUrl: 'git@github.com:qwareeq8/supraspina.git',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  changedPaths: [],
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

function identity(value) {
  const bytes = Buffer.byteLength(value)
  return {
    bytes,
    sha256: createHash('sha256').update(value).digest('hex'),
  }
}

async function packageManifest() {
  return {
    schemaVersion: 1,
    package: {
      name: 'supraspina',
      productName: 'Supraspina',
      version,
      tag: `v${version}`,
      target: 'linux-x86_64',
    },
    source: {
      repository: 'https://github.com/qwareeq8/supraspina',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      clean: true,
    },
    build: {
      nodeEngine: '^22.13.0 || >=24.0.0',
      python: '3.12.10',
      pip: '26.2.1',
      electron: '42.11.18',
      electronBuilder: '26.15.3',
      electronVite: '5.0.0',
      pyinstaller: '6.21.0',
      micromambaRelease: '2.7.0-0',
      micromambaSha256: 'c'.repeat(64),
    },
    signing: {
      decision: 'unsigned',
      reasonCode: 'no-linux-package-signing-identity',
      artifacts: { AppImage: 'unsigned', deb: 'unsigned' },
    },
    inputs: Object.fromEntries(
      await Promise.all(
        RELEASE_COMMAND_INPUTS.map(async (path) => [
          path,
          identity(await readFile(new URL(`../${path}`, import.meta.url))),
        ]),
      ),
    ),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'supraspina-acceptance-'))
  temporaryDirectories.push(root)
  for (const name of coreReleaseAssetNames(version)) {
    await writeFile(join(root, name), `accepted fixture bytes for ${name}`)
  }
  const manifestPath = join(root, 'package-manifest-input.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify(await packageManifest(), null, 2)}\n`,
  )
  return { root, manifestPath }
}

function host(hostVersion) {
  return {
    distribution: 'ubuntu',
    version: hostVersion,
    architecture: 'x86_64',
    kernelRelease:
      hostVersion === '22.04' ? '5.15.0-130-generic' : '6.8.0-52-generic',
    wsl: false,
  }
}

async function hostRecord(paths, hostVersion, results = passedResults) {
  const nativeBuild = await buildRecord(paths)
  return createNativeHostRecord({
    assetsDirectory: paths.root,
    packageManifestPath: paths.manifestPath,
    buildRecord: nativeBuild,
    results,
    host: host(hostVersion),
    tools,
    sourceState,
  })
}

function passedBuildResults() {
  return Object.fromEntries(
    BUILD_COMMAND_IDS.map((id) => [id, { status: 'passed', exitCode: 0 }]),
  )
}

async function buildRecord(paths, commandResults = passedBuildResults()) {
  return createNativeBuildRecord({
    assetsDirectory: paths.root,
    packageManifestPath: paths.manifestPath,
    commandResults,
    host: host('22.04'),
    tools: buildTools,
    sourceState,
  })
}

describe('the build command result options', () => {
  it('accepts every committed build command identifier, including digits', () => {
    const parsed = parseBuildCommandResultOptions(
      BUILD_COMMAND_IDS.map((id) => `${id}=0`),
    )

    assert.deepEqual(Object.keys(parsed), [...BUILD_COMMAND_IDS])
    for (const id of BUILD_COMMAND_IDS) {
      assert.deepEqual(parsed[id], { status: 'passed', exitCode: 0 })
    }
  })

  it('records a not-run and a failed build command', () => {
    const values = BUILD_COMMAND_IDS.map((id) =>
      id === 'package-linux' ? `${id}=1` : `${id}=not-run`,
    )
    const parsed = parseBuildCommandResultOptions(values)

    assert.deepEqual(parsed['package-linux'], { status: 'failed', exitCode: 1 })
    assert.deepEqual(parsed['node-install'], {
      status: 'not-run',
      exitCode: null,
    })
  })

  it('rejects a wrong count, an unknown identifier, or a duplicate', () => {
    assert.throws(
      () => parseBuildCommandResultOptions(['node-install=0']),
      /Provide --command-result exactly/,
    )
    assert.throws(
      () =>
        parseBuildCommandResultOptions(
          BUILD_COMMAND_IDS.map((id, index) =>
            index === 0 ? 'not-a-command=0' : `${id}=0`,
          ),
        ),
      /Provide one recognized build command result/,
    )
    assert.throws(
      () =>
        parseBuildCommandResultOptions(
          BUILD_COMMAND_IDS.map(() => 'node-install=0'),
        ),
      /Provide one recognized build command result/,
    )
  })
})

describe('native release acceptance', () => {
  it('merges Ubuntu 22.04 and 24.04 evidence and verifies published bytes', async () => {
    const paths = await fixture()
    const records = await Promise.all([
      hostRecord(paths, '24.04'),
      hostRecord(paths, '22.04'),
    ])
    const merged = await createMergedReleaseAcceptance({
      assetsDirectory: paths.root,
      packageManifestPath: paths.manifestPath,
      buildRecord: await buildRecord(paths),
      hostRecords: records,
    })
    await writeFile(
      join(paths.root, ACCEPTANCE_FILE),
      `${JSON.stringify(merged, null, 2)}\n`,
    )

    const verified = await verifyPublishedAcceptance(paths.root, version)

    assert.equal(
      validateSchema(verified),
      true,
      JSON.stringify(validateSchema.errors),
    )
    assert.deepEqual(
      verified.hostRecords.map(({ record }) => record.host.version),
      ['22.04', '24.04'],
    )
    assert.equal(verified.source.commit, 'a'.repeat(40))
    assert.equal(verified.release.tag, 'v20261121.1830.0')
    assert.equal(verified.buildRecord.record.host.version, '22.04')
    assert.equal(verified.buildRecord.record.tools.python, '3.12.10')
    assert.deepEqual(
      Object.keys(verified.buildRecord.record.commandResults),
      BUILD_COMMAND_IDS,
    )
    assert.deepEqual(
      verified.commandContract.buildCommands.find(
        ({ id }) => id === 'verify-micromamba-version',
      ).environment,
      BUILD_MAMBA_ENVIRONMENT,
    )
    assert.deepEqual(
      verified.commandContract.buildCommands.find(
        ({ id }) => id === 'package-linux',
      ).argv,
      ['npm', 'run', 'package:linux'],
    )
    assert.deepEqual(
      verified.commandContract.normalLaunchChecks[0].argvSequence[1],
      ['/usr/bin/supraspina'],
    )
    assert.equal(verified.signing.decision, 'unsigned')
    assert.deepEqual(Object.keys(verified.artifacts), [
      'latest-linux.yml',
      'supraspina-20261121.1830.0-amd64.deb',
      'supraspina-20261121.1830.0-x86_64.AppImage',
    ])
  })

  it('requires a passing native Ubuntu 22.04 build record', async () => {
    const paths = await fixture()
    const hosts = await Promise.all([
      hostRecord(paths, '22.04'),
      hostRecord(paths, '24.04'),
    ])
    const failedResults = passedBuildResults()
    failedResults['package-linux'] = { status: 'failed', exitCode: 7 }
    const failedBuild = await buildRecord(paths, failedResults)

    await assert.rejects(
      createMergedReleaseAcceptance({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        buildRecord: failedBuild,
        hostRecords: hosts,
      }),
      /Pass every native build command before merge: package-linux/,
    )
    await assert.rejects(
      createNativeBuildRecord({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        commandResults: passedBuildResults(),
        host: host('24.04'),
        tools: buildTools,
        sourceState,
      }),
      /only on native Ubuntu 22\.04 x86_64/,
    )
  })

  it('requires a supported Node.js release on acceptance hosts', async () => {
    const paths = await fixture()
    await assert.rejects(
      createNativeHostRecord({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        buildRecord: await buildRecord(paths),
        results: passedResults,
        host: host('22.04'),
        tools: { ...tools, node: 'v23.11.1' },
        sourceState,
      }),
      /supported Node\.js release/,
    )
  })

  it('rejects transferred bytes before host installation begins', async () => {
    const paths = await fixture()
    const nativeBuild = await buildRecord(paths)
    await writeFile(
      join(paths.root, `supraspina-${version}-amd64.deb`),
      'mutated during transfer',
    )

    await assert.rejects(
      verifyNativeTransfer({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        buildRecord: nativeBuild,
        host: host('24.04'),
        sourceState,
      }),
      /Match transferred package bytes and source to the native build record/,
    )
  })

  it('rejects incomplete outcomes and observed tools outside the build contract', async () => {
    const paths = await fixture()
    const incomplete = passedBuildResults()
    delete incomplete['node-install']
    await assert.rejects(
      buildRecord(paths, incomplete),
      /exactly the native build command results fields/,
    )
    await assert.rejects(
      createNativeBuildRecord({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        commandResults: passedBuildResults(),
        host: host('22.04'),
        tools: { ...buildTools, pyinstaller: '6.20.0' },
        sourceState,
      }),
      /Match the observed native build tools to the package contract/,
    )
  })

  it('rejects Mint, WSL, and unsupported Ubuntu versions as acceptance hosts', () => {
    assert.throws(
      () => validateNativeHost({ ...host('22.04'), distribution: 'linuxmint' }),
      /only on native Ubuntu 22\.04 or 24\.04 x86_64/,
    )
    assert.throws(
      () => validateNativeHost({ ...host('24.04'), wsl: true }),
      /only on native Ubuntu/,
    )
    assert.throws(
      () => validateNativeHost({ ...host('20.04'), version: '20.04' }),
      /only on native Ubuntu/,
    )
  })

  it('preserves failed evidence but refuses to merge it for publication', async () => {
    const paths = await fixture()
    const failed = await hostRecord(paths, '24.04', {
      ...passedResults,
      appImageNormalLaunch: 'failed',
    })
    const accepted = await hostRecord(paths, '22.04')

    await assert.rejects(
      createMergedReleaseAcceptance({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        buildRecord: await buildRecord(paths),
        hostRecords: [accepted, failed],
      }),
      /Pass every release acceptance check before merge: appImageNormalLaunch/,
    )
  })

  it('rejects acceptance commands that do not match the package-bound source', async () => {
    const paths = await fixture()
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8'))
    manifest.inputs['scripts/smoke-installed-deb.sh'].sha256 = '0'.repeat(64)
    await writeFile(
      paths.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    )

    await assert.rejects(
      hostRecord(paths, '22.04'),
      /Use the package-bound release command source: scripts\/smoke-installed-deb\.sh/,
    )
  })

  it('rejects a package tag that does not exactly match the version', async () => {
    const paths = await fixture()
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8'))
    manifest.package.tag = 'v20261120.1830.0'
    await writeFile(
      paths.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    )

    await assert.rejects(
      hostRecord(paths, '22.04'),
      /Bind acceptance to the exact clean Linux package source/,
    )
  })

  it('rejects a dirty or different source checkout on an acceptance host', async () => {
    const paths = await fixture()
    await assert.rejects(
      createNativeHostRecord({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        buildRecord: await buildRecord(paths),
        results: passedResults,
        host: host('22.04'),
        tools,
        sourceState: {
          ...sourceState,
          changedPaths: ['scripts/local-edit.mjs'],
        },
      }),
      /Clean the package-bound acceptance source: scripts\/local-edit\.mjs/,
    )
    await assert.rejects(
      createNativeHostRecord({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        buildRecord: await buildRecord(paths),
        results: passedResults,
        host: host('22.04'),
        tools,
        sourceState: { ...sourceState, commit: 'd'.repeat(40) },
      }),
      /package-bound source checkout/,
    )
  })

  it('rejects duplicate host versions and records for different artifact bytes', async () => {
    const paths = await fixture()
    const ubuntu22 = await hostRecord(paths, '22.04')
    const anotherUbuntu22 = await hostRecord(paths, '22.04')
    await assert.rejects(
      createMergedReleaseAcceptance({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        buildRecord: await buildRecord(paths),
        hostRecords: [ubuntu22, anotherUbuntu22],
      }),
      /one Ubuntu 22\.04 and one Ubuntu 24\.04/,
    )

    const ubuntu24 = await hostRecord(paths, '24.04')
    await writeFile(
      join(paths.root, `supraspina-${version}-amd64.deb`),
      'changed bytes',
    )
    await assert.rejects(
      createMergedReleaseAcceptance({
        assetsDirectory: paths.root,
        packageManifestPath: paths.manifestPath,
        buildRecord: await buildRecord(paths),
        hostRecords: [ubuntu22, ubuntu24],
      }),
      /exact same package bytes and source/,
    )
  })

  it('rejects a changed published artifact and noncanonical acceptance JSON', async () => {
    const paths = await fixture()
    const records = await Promise.all([
      hostRecord(paths, '22.04'),
      hostRecord(paths, '24.04'),
    ])
    const merged = await createMergedReleaseAcceptance({
      assetsDirectory: paths.root,
      packageManifestPath: paths.manifestPath,
      buildRecord: await buildRecord(paths),
      hostRecords: records,
    })
    await writeFile(join(paths.root, ACCEPTANCE_FILE), JSON.stringify(merged))
    await assert.rejects(
      verifyPublishedAcceptance(paths.root, version),
      /canonical two-space JSON/,
    )

    await writeFile(
      join(paths.root, ACCEPTANCE_FILE),
      `${JSON.stringify(merged, null, 2)}\n`,
    )

    const missingBuildRecord = structuredClone(merged)
    delete missingBuildRecord.buildRecord
    await writeFile(
      join(paths.root, ACCEPTANCE_FILE),
      `${JSON.stringify(missingBuildRecord, null, 2)}\n`,
    )
    await assert.rejects(
      verifyPublishedAcceptance(paths.root, version),
      /exactly the merged release acceptance record fields/,
    )

    const staleBuildRecord = structuredClone(merged)
    staleBuildRecord.buildRecord.sha256 = '0'.repeat(64)
    await writeFile(
      join(paths.root, ACCEPTANCE_FILE),
      `${JSON.stringify(staleBuildRecord, null, 2)}\n`,
    )
    await assert.rejects(
      verifyPublishedAcceptance(paths.root, version),
      /Bind the published native build record to the merged acceptance/,
    )

    await writeFile(
      join(paths.root, ACCEPTANCE_FILE),
      `${JSON.stringify(merged, null, 2)}\n`,
    )
    await writeFile(
      join(paths.root, `supraspina-${version}-x86_64.AppImage`),
      'changed bytes',
    )
    await assert.rejects(
      verifyPublishedAcceptance(paths.root, version),
      /Match the published release artifacts to accepted bytes/,
    )
  })
})

describe('the published acceptance schema', () => {
  it('rejects a merged document that breaks the published contract', async () => {
    const paths = await fixture()
    const merged = await createMergedReleaseAcceptance({
      assetsDirectory: paths.root,
      packageManifestPath: paths.manifestPath,
      buildRecord: await buildRecord(paths),
      hostRecords: await Promise.all([
        hostRecord(paths, '22.04'),
        hostRecord(paths, '24.04'),
      ]),
    })
    assert.equal(
      validateSchema(merged),
      true,
      JSON.stringify(validateSchema.errors),
    )

    const invalid = (mutate) => {
      const document = structuredClone(merged)
      mutate(document)
      assert.equal(validateSchema(document), false)
      return validateSchema.errors.map(({ instancePath, keyword, params }) => ({
        instancePath,
        keyword,
        params,
      }))
    }

    assert.ok(
      invalid((document) => delete document.hostRecords).some(
        ({ keyword, params }) =>
          keyword === 'required' && params.missingProperty === 'hostRecords',
      ),
    )
    assert.ok(
      invalid((document) => {
        document.unreviewedField = 'added by hand'
      }).some(
        ({ keyword, params }) =>
          keyword === 'unevaluatedProperties' &&
          params.unevaluatedProperty === 'unreviewedField',
      ),
    )
    assert.ok(
      invalid((document) => {
        document.schemaVersion = 2
      }).some(
        ({ instancePath, keyword }) =>
          instancePath === '/schemaVersion' && keyword === 'const',
      ),
    )
    assert.ok(
      invalid((document) => document.hostRecords.pop()).some(
        ({ instancePath, keyword, params }) =>
          instancePath === '/hostRecords' &&
          keyword === 'minItems' &&
          params.limit === 2,
      ),
    )
    assert.ok(
      invalid((document) => {
        document.buildRecord.sha256 = 'not-a-digest'
      }).some(
        ({ instancePath, keyword }) =>
          instancePath === '/buildRecord/sha256' && keyword === 'pattern',
      ),
    )
  })
})

describe('the release command inputs', () => {
  it('bind every script and build configuration the release commands run', async () => {
    const { commandContract } = await buildRecord(await fixture())
    const { scripts } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    )
    const invokedFiles = (text) =>
      [
        ...text.matchAll(
          /\b(?:sidecar\/)?scripts\/[\w.-]+\.(?:mjs|cjs|sh|py)\b/g,
        ),
      ].map(([path]) => path)
    const invokedScripts = (text) =>
      [...text.matchAll(/\bnpm\b[^\n]*?\brun ([\w:-]+)/g)].map(
        ([, name]) => name,
      )
    const pendingScripts = []
    const pendingFiles = []
    for (const { argv } of [
      ...commandContract.buildCommands,
      ...commandContract.automatedChecks,
    ]) {
      pendingScripts.push(...invokedScripts(argv.join(' ')))
      pendingFiles.push(
        ...argv.filter((value) => /^(?:sidecar\/)?scripts\//.test(value)),
      )
    }
    // Follow the npm scripts, the scripts that they and the shell scripts
    // invoke, the configuration that electron-vite and electron-builder read,
    // and every relative import outside the application source under src/.
    const seenScripts = new Set()
    const seenFiles = new Set()
    while (pendingScripts.length > 0 || pendingFiles.length > 0) {
      for (const name of pendingScripts.splice(0)) {
        if (seenScripts.has(name)) continue
        seenScripts.add(name)
        const command = scripts[name]
        assert.equal(typeof command, 'string', `npm script ${name}`)
        pendingScripts.push(...invokedScripts(`npm ${command}`))
        pendingFiles.push(...invokedFiles(command))
        if (/\belectron-vite build\b/.test(command)) {
          pendingFiles.push('electron.vite.config.ts')
        }
        if (/\belectron-builder\b/.test(command)) {
          pendingFiles.push('electron-builder.yml')
        }
      }
      for (const path of pendingFiles.splice(0)) {
        if (seenFiles.has(path)) continue
        seenFiles.add(path)
        const source = await readFile(
          new URL(`../${path}`, import.meta.url),
          'utf8',
        )
        if (path.endsWith('.sh')) {
          pendingScripts.push(...invokedScripts(source))
          pendingFiles.push(...invokedFiles(source))
        } else if (/\.(?:mjs|cjs|ts)$/.test(path)) {
          // Match import statements and import() or require() calls, not
          // import text that a script quotes as data.
          for (const [, statement, call] of source.matchAll(
            /^(?:import|export|\})[^'\n]*'(\.{1,2}\/[^']+)'|\b(?:import|require)\('(\.{1,2}\/[^']+)'\)/gm,
          )) {
            const target = posix.join(posix.dirname(path), statement ?? call)
            if (!target.startsWith('src/')) pendingFiles.push(target)
          }
        }
      }
    }

    assert.ok(seenFiles.has('scripts/build-identity.mjs'))
    assert.deepEqual(
      [...seenFiles].filter((path) => !RELEASE_COMMAND_INPUTS.includes(path)),
      [],
    )
  })

  it('are all recorded in the release package manifest', () => {
    assert.deepEqual(
      RELEASE_COMMAND_INPUTS.filter(
        (path) => !releasePackageInputPaths.includes(path),
      ),
      [],
    )
  })
})
