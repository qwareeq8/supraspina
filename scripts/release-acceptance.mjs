#!/usr/bin/env node
/** Records and verifies deterministic native-Ubuntu release acceptance. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseAppVersion } from './app-version.mjs'

/** The merged acceptance record published with every stable release. */
export const ACCEPTANCE_FILE = 'release-acceptance.json'
/** The schema used for host and merged acceptance records. */
export const ACCEPTANCE_SCHEMA_FILE = 'scripts/release-acceptance.schema.json'

const HOST_RECORD_TYPE = 'supraspina-native-host-acceptance'
const BUILD_RECORD_TYPE = 'supraspina-native-build'
const MERGED_RECORD_TYPE = 'supraspina-release-acceptance'
const EXPECTED_REPOSITORY = 'https://github.com/qwareeq8/supraspina'
const EXPECTED_PACKAGE = 'supraspina'
const EXPECTED_TARGET = 'linux-x86_64'
const HOST_VERSIONS = Object.freeze(['22.04', '24.04'])
const RESULT_VALUES = new Set(['passed', 'failed', 'not-run'])
const RESULT_KEYS = Object.freeze([
  'debSmoke',
  'appImageSmoke',
  'packageInspection',
  'debNormalLaunch',
  'appImageNormalLaunch',
  'pybrainageProvisioning',
  'pybrainageReadiness',
  'syntheticOutputReopen',
])
const TOOL_KEYS = Object.freeze([
  'node',
  'npm',
  'bash',
  'dpkg',
  'apt',
  'file',
  'xvfbPackage',
  'fusePackage',
])
const BUILD_TOOL_KEYS = Object.freeze([
  'node',
  'npm',
  'python',
  'pip',
  'bash',
  'curl',
  'sha256sum',
  'file',
  'dpkgDeb',
  'glibc',
  'electron',
  'electronBuilder',
  'electronVite',
  'pyinstaller',
  'micromamba',
])
const COMMON_KEYS = Object.freeze([
  'release',
  'source',
  'packageManifest',
  'buildToolchain',
  'signing',
  'artifacts',
  'commandContract',
])
const SHA256 = /^[0-9a-f]{64}$/
const OBJECT_ID = /^[0-9a-f]{40}$/
// Tool versions recorded from the build host are plain dotted triples.
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const MAX_JSON_BYTES = 4 * 1024 * 1024
const repositoryRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))

/** The exact build commands whose exit outcomes the build record carries. */
export const BUILD_COMMAND_IDS = Object.freeze([
  'node-install',
  'verify-python-version',
  'create-release-python',
  'install-python-toolchain',
  'install-python-release',
  'install-sidecar-source',
  'check-python-release',
  'download-micromamba',
  'verify-micromamba-sha256',
  'make-micromamba-executable',
  'verify-micromamba-version',
  'generate-node-metadata',
  'generate-python-metadata',
  'package-linux',
])

/** The isolated root used for every micromamba build-time version probe. */
export const BUILD_MAMBA_ENVIRONMENT = Object.freeze({
  MAMBA_ROOT_PREFIX: 'build/release-mamba-root',
})

/**
 * Source files whose exact hashes define the build and acceptance commands:
 * every script, configuration, and schema that the commands run, import, or
 * read. The source commit and tree bind the application code they build.
 */
export const RELEASE_COMMAND_INPUTS = Object.freeze([
  'electron-builder.yml',
  'electron.vite.config.ts',
  'package.json',
  'scripts/app-version.mjs',
  'scripts/build-identity.mjs',
  'scripts/build-sidecar.sh',
  'scripts/bundled-packages.mjs',
  'scripts/check-release.mjs',
  'scripts/generate-node-release-metadata.mjs',
  'scripts/inspect-linux-packages.mjs',
  'scripts/package-smoke.mjs',
  'scripts/release-acceptance.mjs',
  ACCEPTANCE_SCHEMA_FILE,
  'scripts/release-assets.mjs',
  'scripts/release-package-manifest.mjs',
  'scripts/smoke-appimage.sh',
  'scripts/smoke-installed-deb.sh',
  'scripts/stage-sidecar-resources.mjs',
  'scripts/stamp-version.mjs',
  'scripts/verify-packaged-application.mjs',
  'sidecar/scripts/generate_release_metadata.py',
  'sidecar/supraspina-sidecar.spec',
])

/**
 * Return the three byte-identical build outputs accepted on both native hosts.
 *
 * @param {string} version
 * @returns {string[]}
 */
export function coreReleaseAssetNames(version) {
  if (!parseAppVersion(version)) {
    throw new Error('Provide a YYYYMMDD.HHMM.0 UTC date-time version.')
  }
  return [
    'latest-linux.yml',
    `supraspina-${version}-amd64.deb`,
    `supraspina-${version}-x86_64.AppImage`,
  ]
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Provide ${label} as an object.`)
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (!same(actual, expected)) {
    throw new Error(`Provide exactly the ${label} fields.`)
  }
}

function safeOneLine(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`Record a bounded one-line ${label}.`)
  }
  return value
}

function assertIdentity(value, label) {
  exactKeys(value, ['bytes', 'sha256'], `${label} identity`)
  if (
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    !SHA256.test(value.sha256)
  ) {
    throw new Error(`Record exact bytes and SHA-256 for ${label}.`)
  }
}

async function fileIdentity(path, label) {
  const info = await lstat(path)
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`Provide ${label} as a nonempty regular file.`)
  }
  const hash = createHash('sha256')
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectHash)
    stream.on('end', resolveHash)
  })
  return { bytes: info.size, sha256: hash.digest('hex') }
}

async function readCanonicalJson(path, label) {
  const info = await lstat(path)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_JSON_BYTES) {
    throw new Error(`Provide ${label} as a bounded nonempty regular JSON file.`)
  }
  const source = await readFile(path, 'utf8')
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`Provide valid JSON for ${label}.`)
  }
  if (source !== canonicalJson(value)) {
    throw new Error(
      `Write ${label} as canonical two-space JSON with a newline.`,
    )
  }
  return { value, identity: await fileIdentity(path, label) }
}

async function writeCanonicalJson(path, value) {
  await writeFile(path, canonicalJson(value), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  })
  await chmod(path, 0o644)
}

function validateSigning(signing) {
  const expected = {
    decision: 'unsigned',
    reasonCode: 'no-linux-package-signing-identity',
    artifacts: { AppImage: 'unsigned', deb: 'unsigned' },
  }
  if (!same(signing, expected)) {
    throw new Error('Record the reviewed machine-readable unsigned decision.')
  }
}

function validatePackageManifest(manifest, expectedVersion) {
  exactKeys(
    manifest,
    ['schemaVersion', 'package', 'source', 'build', 'signing', 'inputs'],
    'release package manifest',
  )
  exactKeys(
    manifest.package,
    ['name', 'productName', 'version', 'tag', 'target'],
    'package identity',
  )
  exactKeys(
    manifest.source,
    ['repository', 'commit', 'tree', 'clean'],
    'source identity',
  )
  exactKeys(
    manifest.build,
    [
      'nodeEngine',
      'python',
      'pip',
      'electron',
      'electronBuilder',
      'electronVite',
      'pyinstaller',
      'micromambaRelease',
      'micromambaSha256',
    ],
    'build toolchain',
  )
  if (
    manifest.schemaVersion !== 1 ||
    manifest.package.name !== EXPECTED_PACKAGE ||
    manifest.package.productName !== 'Supraspina' ||
    manifest.package.version !== expectedVersion ||
    manifest.package.tag !== `v${expectedVersion}` ||
    manifest.package.target !== EXPECTED_TARGET ||
    manifest.source.repository !== EXPECTED_REPOSITORY ||
    !OBJECT_ID.test(manifest.source.commit ?? '') ||
    !OBJECT_ID.test(manifest.source.tree ?? '') ||
    manifest.source.clean !== true ||
    !/^\^?\d/.test(manifest.build.nodeEngine ?? '') ||
    !VERSION.test(manifest.build.python ?? '') ||
    !VERSION.test(manifest.build.pip ?? '') ||
    !VERSION.test(manifest.build.electron ?? '') ||
    !VERSION.test(manifest.build.electronBuilder ?? '') ||
    !VERSION.test(manifest.build.electronVite ?? '') ||
    !VERSION.test(manifest.build.pyinstaller ?? '') ||
    typeof manifest.build.micromambaRelease !== 'string' ||
    !SHA256.test(manifest.build.micromambaSha256 ?? '')
  ) {
    throw new Error('Bind acceptance to the exact clean Linux package source.')
  }
  validateSigning(manifest.signing)
  if (
    manifest.inputs === null ||
    typeof manifest.inputs !== 'object' ||
    Array.isArray(manifest.inputs)
  ) {
    throw new Error('Record the package input identities.')
  }
  for (const [path, identity] of Object.entries(manifest.inputs)) {
    if (!path || path.startsWith('/') || path.includes('..')) {
      throw new Error('Use repository-relative package input paths.')
    }
    assertIdentity(identity, path)
  }
  for (const path of RELEASE_COMMAND_INPUTS) {
    if (!(path in manifest.inputs)) {
      throw new Error(
        `Bind the release command source in the package: ${path}.`,
      )
    }
  }
}

function commandContract(version, inputs, buildToolchain) {
  const deb = `supraspina-${version}-amd64.deb`
  const appImage = `supraspina-${version}-x86_64.AppImage`
  const asset = (name) => `<accepted-assets>/${name}`
  const releasePythonDirectory = `build/release-python-${buildToolchain.python}`
  const releasePython = `${releasePythonDirectory}/bin/python`
  const micromamba = 'resources/micromamba/micromamba'
  return {
    workingDirectory: 'repository-root',
    assetDirectoryToken: '<accepted-assets>',
    buildCommands: [
      { id: 'node-install', argv: ['npm', 'ci'], environment: {} },
      {
        id: 'verify-python-version',
        argv: [
          'python3.12',
          '-c',
          'import platform; print(platform.python_version())',
        ],
        environment: {},
      },
      {
        id: 'create-release-python',
        argv: ['python3.12', '-m', 'venv', releasePythonDirectory],
        environment: {},
      },
      {
        id: 'install-python-toolchain',
        argv: [
          releasePython,
          '-m',
          'pip',
          'install',
          '--require-hashes',
          '--only-binary=:all:',
          '-r',
          'sidecar/requirements/toolchain.txt',
        ],
        environment: {},
      },
      {
        id: 'install-python-release',
        argv: [
          releasePython,
          '-m',
          'pip',
          'install',
          '--require-hashes',
          '--only-binary=:all:',
          '-r',
          'sidecar/requirements/release-linux-x86_64.txt',
        ],
        environment: {},
      },
      {
        id: 'install-sidecar-source',
        argv: [
          releasePython,
          '-m',
          'pip',
          'install',
          '--no-deps',
          '--no-build-isolation',
          '-e',
          './sidecar',
        ],
        environment: {},
      },
      {
        id: 'check-python-release',
        argv: [releasePython, '-m', 'pip', 'check'],
        environment: {},
      },
      {
        id: 'download-micromamba',
        argv: [
          'curl',
          '-fL',
          `https://github.com/mamba-org/micromamba-releases/releases/download/${buildToolchain.micromambaRelease}/micromamba-linux-64`,
          '-o',
          micromamba,
        ],
        environment: {},
      },
      {
        id: 'verify-micromamba-sha256',
        argv: ['sha256sum', '--check', '-'],
        environment: {},
        standardInput: `${buildToolchain.micromambaSha256}  ${micromamba}\n`,
      },
      {
        id: 'make-micromamba-executable',
        argv: ['chmod', '0755', micromamba],
        environment: {},
      },
      {
        id: 'verify-micromamba-version',
        argv: [micromamba, '--version'],
        environment: BUILD_MAMBA_ENVIRONMENT,
      },
      {
        id: 'generate-node-metadata',
        argv: ['npm', 'run', 'metadata:node'],
        environment: {},
      },
      {
        id: 'generate-python-metadata',
        argv: [
          releasePython,
          'sidecar/scripts/generate_release_metadata.py',
          '--target',
          'linux-x86_64',
          '--output',
          'build/release-metadata/dependency-manifests',
        ],
        environment: {},
      },
      {
        id: 'package-linux',
        argv: ['npm', 'run', 'package:linux'],
        environment: { SUPRASPINA_BUILD_PYTHON: releasePython },
      },
    ],
    automatedChecks: [
      {
        id: 'deb-smoke',
        argv: ['scripts/smoke-installed-deb.sh', asset(deb)],
      },
      {
        id: 'appimage-smoke',
        argv: ['scripts/smoke-appimage.sh', asset(appImage)],
      },
      {
        id: 'package-inspection',
        argv: [
          'node',
          'scripts/inspect-linux-packages.mjs',
          '--appimage',
          asset(appImage),
          '--deb',
          asset(deb),
        ],
      },
    ],
    normalLaunchChecks: [
      {
        id: 'deb-normal-launch',
        argvSequence: [
          ['sudo', 'apt-get', 'install', '--yes', asset(deb)],
          ['/usr/bin/supraspina'],
          ['sudo', 'apt-get', 'purge', '--yes', 'supraspina'],
        ],
        successCondition:
          'The installed launcher opens Supraspina, the operator observes and closes it, and purge removes it.',
      },
      {
        id: 'appimage-normal-launch',
        argvSequence: [[asset(appImage)]],
        successCondition:
          'The AppImage opens Supraspina through its normal FUSE launch path, and the operator observes and closes it.',
      },
    ],
    implementationInputs: Object.fromEntries(
      RELEASE_COMMAND_INPUTS.map((path) => [path, inputs[path]]),
    ),
  }
}

async function commonContract(assetsDirectory, packageManifestPath) {
  const { value: manifest, identity: manifestIdentity } =
    await readCanonicalJson(packageManifestPath, 'release package manifest')
  const version = manifest?.package?.version
  if (!parseAppVersion(version ?? '')) {
    throw new Error('Record a date-time package version for acceptance.')
  }
  validatePackageManifest(manifest, version)
  for (const path of RELEASE_COMMAND_INPUTS) {
    const actual = await fileIdentity(
      join(repositoryRoot, path),
      `acceptance command source ${path}`,
    )
    if (!same(actual, manifest.inputs[path])) {
      throw new Error(`Use the package-bound release command source: ${path}.`)
    }
  }
  const names = coreReleaseAssetNames(version)
  const artifacts = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await fileIdentity(
          join(assetsDirectory, name),
          `release asset ${name}`,
        ),
      ]),
    ),
  )
  return {
    release: {
      repository: manifest.source.repository,
      packageName: manifest.package.name,
      productName: manifest.package.productName,
      version,
      tag: manifest.package.tag,
      target: manifest.package.target,
    },
    source: manifest.source,
    packageManifest: {
      filename: 'release-package-manifest.json',
      ...manifestIdentity,
    },
    buildToolchain: manifest.build,
    signing: manifest.signing,
    artifacts,
    commandContract: commandContract(version, manifest.inputs, manifest.build),
  }
}

function validateCommon(common, expectedVersion) {
  exactKeys(common, COMMON_KEYS, 'acceptance contract')
  exactKeys(
    common.release,
    ['repository', 'packageName', 'productName', 'version', 'tag', 'target'],
    'accepted release',
  )
  if (
    common.release.repository !== EXPECTED_REPOSITORY ||
    common.release.packageName !== EXPECTED_PACKAGE ||
    common.release.productName !== 'Supraspina' ||
    common.release.version !== expectedVersion ||
    common.release.tag !== `v${expectedVersion}` ||
    common.release.target !== EXPECTED_TARGET
  ) {
    throw new Error('Record the canonical Linux release identity.')
  }
  exactKeys(
    common.source,
    ['repository', 'commit', 'tree', 'clean'],
    'accepted source',
  )
  if (
    common.source.repository !== EXPECTED_REPOSITORY ||
    !OBJECT_ID.test(common.source.commit ?? '') ||
    !OBJECT_ID.test(common.source.tree ?? '') ||
    common.source.clean !== true
  ) {
    throw new Error('Record a clean full source identity.')
  }
  exactKeys(
    common.packageManifest,
    ['filename', 'bytes', 'sha256'],
    'package manifest binding',
  )
  if (common.packageManifest.filename !== 'release-package-manifest.json') {
    throw new Error('Bind the embedded release package manifest.')
  }
  assertIdentity(
    {
      bytes: common.packageManifest.bytes,
      sha256: common.packageManifest.sha256,
    },
    'release package manifest',
  )
  exactKeys(
    common.buildToolchain,
    [
      'nodeEngine',
      'python',
      'pip',
      'electron',
      'electronBuilder',
      'electronVite',
      'pyinstaller',
      'micromambaRelease',
      'micromambaSha256',
    ],
    'accepted build toolchain',
  )
  for (const [name, value] of Object.entries(common.buildToolchain)) {
    safeOneLine(value, `build tool ${name}`)
  }
  if (!SHA256.test(common.buildToolchain.micromambaSha256)) {
    throw new Error('Record the exact micromamba SHA-256.')
  }
  validateSigning(common.signing)

  const artifactNames = coreReleaseAssetNames(expectedVersion)
  exactKeys(common.artifacts, artifactNames, 'accepted artifacts')
  for (const name of artifactNames) {
    assertIdentity(common.artifacts[name], name)
  }

  exactKeys(
    common.commandContract,
    [
      'workingDirectory',
      'assetDirectoryToken',
      'buildCommands',
      'automatedChecks',
      'normalLaunchChecks',
      'implementationInputs',
    ],
    'acceptance command contract',
  )
  exactKeys(
    common.commandContract.implementationInputs,
    RELEASE_COMMAND_INPUTS,
    'acceptance command inputs',
  )
  for (const path of RELEASE_COMMAND_INPUTS) {
    assertIdentity(common.commandContract.implementationInputs[path], path)
  }
  const expectedCommands = commandContract(
    expectedVersion,
    common.commandContract.implementationInputs,
    common.buildToolchain,
  )
  if (!same(common.commandContract, expectedCommands)) {
    throw new Error(
      'Use the exact reviewed build and acceptance command contract.',
    )
  }
}

/**
 * Validate and normalize one native Ubuntu host observation.
 *
 * @param {object} observation - The inspected operating-system state.
 * @returns {object} The accepted host identity.
 * @throws {Error} On non-Ubuntu, unsupported, non-x86_64, or WSL hosts.
 */
export function validateNativeHost(observation) {
  exactKeys(
    observation,
    ['distribution', 'version', 'architecture', 'kernelRelease', 'wsl'],
    'native host identity',
  )
  if (
    observation.distribution !== 'ubuntu' ||
    !HOST_VERSIONS.includes(observation.version) ||
    observation.architecture !== 'x86_64' ||
    observation.wsl !== false
  ) {
    throw new Error(
      'Record acceptance only on native Ubuntu 22.04 or 24.04 x86_64.',
    )
  }
  if (!/^[A-Za-z0-9._+~-]{1,128}$/.test(observation.kernelRelease ?? '')) {
    throw new Error('Record a bounded kernel release for the native host.')
  }
  return { ...observation }
}

function parseOsRelease(source) {
  const values = {}
  for (const line of source.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

async function inspectNativeHost() {
  const osRelease = parseOsRelease(await readFile('/etc/os-release', 'utf8'))
  const [kernelRelease, kernelVersion] = await Promise.all([
    readFile('/proc/sys/kernel/osrelease', 'utf8'),
    readFile('/proc/version', 'utf8'),
  ])
  return validateNativeHost({
    distribution: osRelease.ID ?? '',
    version: osRelease.VERSION_ID ?? '',
    architecture: execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim(),
    kernelRelease: kernelRelease.trim(),
    wsl: /microsoft|wsl/i.test(`${kernelRelease}\n${kernelVersion}`),
  })
}

function commandVersion(command, args, environment = {}) {
  const output = execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const firstLine = output
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim()
  return safeOneLine(firstLine, `${command} version`)
}

function inspectAcceptanceTools(hostVersion) {
  const fusePackage = hostVersion === '22.04' ? 'libfuse2' : 'libfuse2t64'
  return {
    node: safeOneLine(process.version, 'Node.js version'),
    npm: commandVersion('npm', ['--version']),
    bash: commandVersion('bash', ['--version']),
    dpkg: commandVersion('dpkg', ['--version']),
    apt: commandVersion('apt-get', ['--version']),
    file: commandVersion('file', ['--version']),
    xvfbPackage: commandVersion('dpkg-query', [
      '--show',
      '--showformat=${Version}\n',
      'xvfb',
    ]),
    fusePackage: commandVersion('dpkg-query', [
      '--show',
      '--showformat=${Version}\n',
      fusePackage,
    ]),
  }
}

async function installedNodePackageVersion(name) {
  const path = join(repositoryRoot, 'node_modules', name, 'package.json')
  const info = await lstat(path)
  if (!info.isFile() || info.size <= 0 || info.size > MAX_JSON_BYTES) {
    throw new Error(`Provide the installed ${name} package metadata.`)
  }
  const value = JSON.parse(await readFile(path, 'utf8'))
  return safeOneLine(value.version, `${name} version`)
}

async function inspectBuildTools(buildToolchain) {
  const releasePython = `build/release-python-${buildToolchain.python}/bin/python`
  return {
    node: safeOneLine(process.version, 'Node.js version'),
    npm: commandVersion('npm', ['--version']),
    python: commandVersion(releasePython, [
      '-c',
      'import platform; print(platform.python_version())',
    ]),
    pip: commandVersion(releasePython, [
      '-c',
      'import importlib.metadata; print(importlib.metadata.version("pip"))',
    ]),
    bash: commandVersion('bash', ['--version']),
    curl: commandVersion('curl', ['--version']),
    sha256sum: commandVersion('sha256sum', ['--version']),
    file: commandVersion('file', ['--version']),
    dpkgDeb: commandVersion('dpkg-deb', ['--version']),
    glibc: commandVersion('ldd', ['--version']),
    electron: await installedNodePackageVersion('electron'),
    electronBuilder: await installedNodePackageVersion('electron-builder'),
    electronVite: await installedNodePackageVersion('electron-vite'),
    pyinstaller: commandVersion(releasePython, [
      '-c',
      'import importlib.metadata; print(importlib.metadata.version("pyinstaller"))',
    ]),
    micromamba: commandVersion(
      'resources/micromamba/micromamba',
      ['--version'],
      BUILD_MAMBA_ENVIRONMENT,
    ),
  }
}

function validateTools(tools) {
  exactKeys(tools, TOOL_KEYS, 'acceptance tool versions')
  for (const key of TOOL_KEYS) safeOneLine(tools[key], `${key} version`)
  validateSupportedNodeVersion(tools.node)
}

function validateSupportedNodeVersion(value) {
  const node = /^v(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (
    !node ||
    !(
      (Number(node[1]) === 22 && Number(node[2]) >= 13) ||
      Number(node[1]) >= 24
    )
  ) {
    throw new Error('Use a supported Node.js release on each acceptance host.')
  }
}

function validateBuildTools(tools, common) {
  exactKeys(tools, BUILD_TOOL_KEYS, 'native build tool versions')
  for (const key of BUILD_TOOL_KEYS) {
    safeOneLine(tools[key], `${key} build version`)
  }
  const node = /^v22\.(\d+)\.(\d+)$/.exec(tools.node)
  const micromamba = /^(\d+(?:\.\d+)*)-\d+$/.exec(
    common.buildToolchain.micromambaRelease,
  )?.[1]
  if (
    !node ||
    Number(node[1]) < 13 ||
    tools.python !== common.buildToolchain.python ||
    tools.pip !== common.buildToolchain.pip ||
    tools.electron !== common.buildToolchain.electron ||
    tools.electronBuilder !== common.buildToolchain.electronBuilder ||
    tools.electronVite !== common.buildToolchain.electronVite ||
    tools.pyinstaller !== common.buildToolchain.pyinstaller ||
    tools.micromamba !== micromamba
  ) {
    throw new Error(
      'Match the observed native build tools to the package contract.',
    )
  }
}

function validateBuildCommandResults(results, requirePassed) {
  exactKeys(results, BUILD_COMMAND_IDS, 'native build command results')
  for (const id of BUILD_COMMAND_IDS) {
    const result = results[id]
    exactKeys(result, ['status', 'exitCode'], `${id} build result`)
    const valid =
      (result.status === 'passed' && result.exitCode === 0) ||
      (result.status === 'failed' &&
        Number.isSafeInteger(result.exitCode) &&
        result.exitCode >= 1 &&
        result.exitCode <= 255) ||
      (result.status === 'not-run' && result.exitCode === null)
    if (!valid) {
      throw new Error(`Record an exact exit outcome for ${id}.`)
    }
    if (requirePassed && result.status !== 'passed') {
      throw new Error(`Pass every native build command before merge: ${id}.`)
    }
  }
}

function validateResults(results, requirePassed) {
  exactKeys(results, RESULT_KEYS, 'acceptance results')
  for (const key of RESULT_KEYS) {
    if (!RESULT_VALUES.has(results[key])) {
      throw new Error(`Record passed, failed, or not-run for ${key}.`)
    }
    if (requirePassed && results[key] !== 'passed') {
      throw new Error(
        `Pass every release acceptance check before merge: ${key}.`,
      )
    }
  }
}

function captureGit(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function inspectSourceCheckout() {
  const nulPaths = (args) => captureGit(args).split('\0').filter(Boolean)
  return {
    repositoryUrl: captureGit(['remote', 'get-url', 'origin']).trim(),
    commit: captureGit(['rev-parse', '--verify', 'HEAD']).trim(),
    tree: captureGit(['rev-parse', '--verify', 'HEAD^{tree}']).trim(),
    changedPaths: [
      ...nulPaths(['diff', '--name-only', '-z', 'HEAD']),
      ...nulPaths(['diff', '--cached', '--name-only', '-z', 'HEAD']),
      ...nulPaths(['ls-files', '--others', '--exclude-standard', '-z']),
    ],
  }
}

function normalizeRepositoryUrl(value) {
  if (typeof value !== 'string') return ''
  if (value.startsWith('git@github.com:')) {
    return `https://github.com/${value
      .slice('git@github.com:'.length)
      .replace(/\.git$/, '')}`
  }
  try {
    const parsed = new URL(value)
    if (parsed.hostname !== 'github.com') return ''
    return `https://github.com/${parsed.pathname
      .replace(/^\/|\/$/g, '')
      .replace(/\.git$/, '')}`
  } catch {
    return ''
  }
}

function validateSourceCheckout(sourceState, expected) {
  exactKeys(
    sourceState,
    ['repositoryUrl', 'commit', 'tree', 'changedPaths'],
    'acceptance source checkout',
  )
  if (
    normalizeRepositoryUrl(sourceState.repositoryUrl) !== EXPECTED_REPOSITORY ||
    sourceState.commit !== expected.commit ||
    sourceState.tree !== expected.tree ||
    !Array.isArray(sourceState.changedPaths)
  ) {
    throw new Error('Run acceptance from the package-bound source checkout.')
  }
  const changedPaths = [...new Set(sourceState.changedPaths)]
  if (
    changedPaths.some((path) => typeof path !== 'string' || path.length === 0)
  ) {
    throw new Error('Inspect every acceptance source path.')
  }
  if (changedPaths.length > 0) {
    throw new Error(
      `Clean the package-bound acceptance source: ${changedPaths.sort().join(', ')}.`,
    )
  }
}

function recordCommon(record) {
  return Object.fromEntries(COMMON_KEYS.map((key) => [key, record[key]]))
}

function validateHostRecord(record, requirePassed = false) {
  exactKeys(
    record,
    [
      'schemaVersion',
      'recordType',
      ...COMMON_KEYS,
      'buildRecordSha256',
      'host',
      'tools',
      'results',
    ],
    'native host acceptance record',
  )
  if (record.schemaVersion !== 1 || record.recordType !== HOST_RECORD_TYPE) {
    throw new Error('Use the native host acceptance record schema version 1.')
  }
  const version = record.release?.version
  if (!parseAppVersion(version ?? '')) {
    throw new Error('Record a date-time accepted release version.')
  }
  validateCommon(recordCommon(record), version)
  validateNativeHost(record.host)
  if (!SHA256.test(record.buildRecordSha256 ?? '')) {
    throw new Error('Bind host acceptance to the native build record.')
  }
  validateTools(record.tools)
  validateResults(record.results, requirePassed)
}

function validateBuildRecord(record, requirePassed = false) {
  exactKeys(
    record,
    [
      'schemaVersion',
      'recordType',
      ...COMMON_KEYS,
      'host',
      'tools',
      'commandResults',
    ],
    'native build record',
  )
  if (record.schemaVersion !== 1 || record.recordType !== BUILD_RECORD_TYPE) {
    throw new Error('Use the native build record schema version 1.')
  }
  const version = record.release?.version
  if (!parseAppVersion(version ?? '')) {
    throw new Error('Record a date-time built release version.')
  }
  const common = recordCommon(record)
  validateCommon(common, version)
  validateNativeHost(record.host)
  if (record.host.version !== '22.04') {
    throw new Error(
      'Build release packages only on native Ubuntu 22.04 x86_64.',
    )
  }
  validateBuildTools(record.tools, common)
  validateBuildCommandResults(record.commandResults, requirePassed)
}

/**
 * Verify transferred package bytes against the passing native build record.
 *
 * Run this before installing dependencies or either application package on an
 * acceptance host. Native-host eligibility is checked before artifact reads.
 */
export async function verifyNativeTransfer({
  assetsDirectory,
  packageManifestPath,
  buildRecord,
  host,
  sourceState,
}) {
  const acceptedHost = validateNativeHost(host ?? (await inspectNativeHost()))
  validateBuildRecord(buildRecord, true)
  const common = await commonContract(assetsDirectory, packageManifestPath)
  validateSourceCheckout(sourceState ?? inspectSourceCheckout(), common.source)
  if (!same(recordCommon(buildRecord), common)) {
    throw new Error(
      'Match transferred package bytes and source to the native build record.',
    )
  }
  return {
    host: acceptedHost,
    common,
    buildRecordSha256: canonicalRecordDigest(buildRecord),
  }
}

/**
 * Build the deterministic record for one completed native Ubuntu package build.
 *
 * @param {object} options
 * @param {string} options.assetsDirectory - The directory holding the three
 *   core assets.
 * @param {string} options.packageManifestPath - The generated package
 *   manifest.
 * @param {object} options.commandResults - Every exact build-command exit
 *   outcome.
 * @param {object} [options.host] - A host observation, injected by tests.
 * @param {object} [options.tools] - Tool versions, injected by tests.
 * @param {object} [options.sourceState] - The source checkout, injected by
 *   tests.
 * @returns {Promise<object>}
 * @throws {Error} On unsupported hosts, mismatched tools, dirty source, or
 *   incomplete outcomes.
 */
export async function createNativeBuildRecord({
  assetsDirectory,
  packageManifestPath,
  commandResults,
  host,
  tools,
  sourceState,
}) {
  const buildHost = validateNativeHost(host ?? (await inspectNativeHost()))
  if (buildHost.version !== '22.04') {
    throw new Error(
      'Build release packages only on native Ubuntu 22.04 x86_64.',
    )
  }
  validateBuildCommandResults(commandResults, false)
  const common = await commonContract(assetsDirectory, packageManifestPath)
  validateSourceCheckout(sourceState ?? inspectSourceCheckout(), common.source)
  const buildTools = tools ?? (await inspectBuildTools(common.buildToolchain))
  validateBuildTools(buildTools, common)
  return {
    schemaVersion: 1,
    recordType: BUILD_RECORD_TYPE,
    ...common,
    host: buildHost,
    tools: buildTools,
    commandResults,
  }
}

/**
 * Build one deterministic native-host record without writing it.
 *
 * @param {object} options
 * @param {string} options.assetsDirectory - The directory holding the three
 *   core assets.
 * @param {string} options.packageManifestPath - The generated package
 *   manifest.
 * @param {object} options.buildRecord - The canonical passing native build
 *   record.
 * @param {object} options.results - Every explicit acceptance outcome.
 * @param {object} [options.host] - A host observation, injected by tests.
 * @param {object} [options.tools] - Tool versions, injected by tests.
 * @param {object} [options.sourceState] - The source checkout, injected by
 *   tests.
 * @returns {Promise<object>}
 * @throws {Error} On unsupported hosts, incomplete outcomes, or mismatched
 *   bytes.
 */
export async function createNativeHostRecord({
  assetsDirectory,
  packageManifestPath,
  buildRecord,
  results,
  host,
  tools,
  sourceState,
}) {
  const transfer = await verifyNativeTransfer({
    assetsDirectory,
    packageManifestPath,
    buildRecord,
    host,
    sourceState,
  })
  const acceptedHost = transfer.host
  const acceptedTools = tools ?? inspectAcceptanceTools(acceptedHost.version)
  validateTools(acceptedTools)
  validateResults(results, false)
  return {
    schemaVersion: 1,
    recordType: HOST_RECORD_TYPE,
    ...transfer.common,
    buildRecordSha256: transfer.buildRecordSha256,
    host: acceptedHost,
    tools: acceptedTools,
    results: { ...results },
  }
}

function canonicalRecordDigest(record) {
  return createHash('sha256').update(canonicalJson(record)).digest('hex')
}

/**
 * Merge exact Ubuntu 22.04 and 24.04 records for the same artifact bytes.
 *
 * @param {object} options
 * @param {string} options.assetsDirectory - The directory holding the three
 *   core assets.
 * @param {string} options.packageManifestPath - The generated package
 *   manifest.
 * @param {object} options.buildRecord - The canonical native Ubuntu build
 *   record.
 * @param {object[]} options.hostRecords - Exactly two parsed canonical
 *   records.
 * @returns {Promise<object>} The deterministic publication record.
 * @throws {Error} On failed checks, duplicate hosts, or mismatched contracts.
 */
export async function createMergedReleaseAcceptance({
  assetsDirectory,
  packageManifestPath,
  buildRecord,
  hostRecords,
}) {
  if (!Array.isArray(hostRecords) || hostRecords.length !== 2) {
    throw new Error('Provide exactly two native Ubuntu host records.')
  }
  const common = await commonContract(assetsDirectory, packageManifestPath)
  validateBuildRecord(buildRecord, true)
  if (!same(recordCommon(buildRecord), common)) {
    throw new Error(
      'Merge a native build record for the exact same package bytes and source.',
    )
  }
  const ordered = [...hostRecords].sort((left, right) =>
    String(left.host?.version).localeCompare(String(right.host?.version)),
  )
  const buildRecordSha256 = canonicalRecordDigest(buildRecord)
  for (const record of ordered) {
    validateHostRecord(record, true)
    if (!same(recordCommon(record), common)) {
      throw new Error(
        'Merge host records for the exact same package bytes and source.',
      )
    }
    if (record.buildRecordSha256 !== buildRecordSha256) {
      throw new Error(
        'Bind every host record to the merged native build record.',
      )
    }
  }
  if (
    !same(
      ordered.map((record) => record.host.version),
      HOST_VERSIONS,
    )
  ) {
    throw new Error('Merge one Ubuntu 22.04 and one Ubuntu 24.04 host record.')
  }
  return {
    schemaVersion: 1,
    recordType: MERGED_RECORD_TYPE,
    ...common,
    buildRecord: {
      sha256: buildRecordSha256,
      record: buildRecord,
    },
    hostRecords: ordered.map((record) => ({
      sha256: canonicalRecordDigest(record),
      record,
    })),
  }
}

function validateMergedRecord(record, expectedVersion) {
  exactKeys(
    record,
    [
      'schemaVersion',
      'recordType',
      ...COMMON_KEYS,
      'buildRecord',
      'hostRecords',
    ],
    'merged release acceptance record',
  )
  if (record.schemaVersion !== 1 || record.recordType !== MERGED_RECORD_TYPE) {
    throw new Error('Use the merged release acceptance schema version 1.')
  }
  validateCommon(recordCommon(record), expectedVersion)
  exactKeys(record.buildRecord, ['sha256', 'record'], 'published build record')
  if (!SHA256.test(record.buildRecord.sha256 ?? '')) {
    throw new Error('Record the canonical native build record SHA-256.')
  }
  validateBuildRecord(record.buildRecord.record, true)
  if (
    !same(recordCommon(record.buildRecord.record), recordCommon(record)) ||
    record.buildRecord.sha256 !==
      canonicalRecordDigest(record.buildRecord.record)
  ) {
    throw new Error(
      'Bind the published native build record to the merged acceptance.',
    )
  }
  if (!Array.isArray(record.hostRecords) || record.hostRecords.length !== 2) {
    throw new Error('Publish exactly two native Ubuntu host records.')
  }
  const versions = []
  for (const entry of record.hostRecords) {
    exactKeys(entry, ['sha256', 'record'], 'published host record')
    if (!SHA256.test(entry.sha256 ?? '')) {
      throw new Error('Record the canonical host record SHA-256.')
    }
    validateHostRecord(entry.record, true)
    if (
      !same(recordCommon(entry.record), recordCommon(record)) ||
      entry.sha256 !== canonicalRecordDigest(entry.record)
    ) {
      throw new Error(
        'Bind every published host record to the merged acceptance.',
      )
    }
    if (entry.record.buildRecordSha256 !== record.buildRecord.sha256) {
      throw new Error(
        'Bind every published host record to the native build record.',
      )
    }
    versions.push(entry.record.host.version)
  }
  if (!same(versions, HOST_VERSIONS)) {
    throw new Error('Publish Ubuntu 22.04 and 24.04 host records in order.')
  }
}

/**
 * Verify the published acceptance record against downloaded artifact bytes.
 *
 * @param {string} directory - The downloaded release-asset directory.
 * @param {string} version
 * @returns {Promise<object>} The verified merged record.
 * @throws {Error} On noncanonical records, failed checks, or changed bytes.
 */
export async function verifyPublishedAcceptance(directory, version) {
  if (!parseAppVersion(version)) {
    throw new Error('Provide a YYYYMMDD.HHMM.0 UTC date-time version.')
  }
  const { value: record } = await readCanonicalJson(
    join(directory, ACCEPTANCE_FILE),
    'merged release acceptance record',
  )
  validateMergedRecord(record, version)
  const actualArtifacts = Object.fromEntries(
    await Promise.all(
      coreReleaseAssetNames(version).map(async (name) => [
        name,
        await fileIdentity(join(directory, name), `release asset ${name}`),
      ]),
    ),
  )
  if (!same(record.artifacts, actualArtifacts)) {
    throw new Error('Match the published release artifacts to accepted bytes.')
  }
  return record
}

function requiredOption(options, name) {
  const value = options.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Provide --${name}.`)
  }
  return value
}

function parseOptions(args, repeated = new Set()) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!/^--[a-z][a-z-]*$/.test(flag ?? '') || !value) {
      throw new Error(
        'Provide release acceptance options as --name value pairs.',
      )
    }
    const name = flag.slice(2)
    if (options.has(name) && !repeated.has(name)) {
      throw new Error(`Provide --${name} once.`)
    }
    if (repeated.has(name)) {
      options.set(name, [...(options.get(name) ?? []), value])
    } else {
      options.set(name, value)
    }
  }
  return options
}

function rejectUnknown(options, allowed) {
  const unknown = [...options.keys()].find((name) => !allowed.has(name))
  if (unknown) throw new Error(`Remove the unknown option --${unknown}.`)
}

/**
 * Parse the `--command-result <id>=<exit code>` options for one native build.
 *
 * @param {string[]} values - One entry per build command identifier.
 * @returns {object} The build command outcomes, in order.
 * @throws {Error} On a wrong count, an unknown identifier, or a duplicate.
 */
export function parseBuildCommandResultOptions(values) {
  if (!Array.isArray(values) || values.length !== BUILD_COMMAND_IDS.length) {
    throw new Error(
      `Provide --command-result exactly ${BUILD_COMMAND_IDS.length} times.`,
    )
  }
  const results = {}
  for (const value of values) {
    // Build command identifiers may contain digits, as verify-micromamba-sha256 does.
    const match = /^([a-z][a-z0-9-]*)=(not-run|\d{1,3})$/.exec(value)
    if (
      !match ||
      !BUILD_COMMAND_IDS.includes(match[1]) ||
      match[1] in results
    ) {
      throw new Error(`Provide one recognized build command result: ${value}.`)
    }
    const [, id, outcome] = match
    const exitCode = outcome === 'not-run' ? null : Number(outcome)
    results[id] = {
      status:
        outcome === 'not-run'
          ? 'not-run'
          : exitCode === 0
            ? 'passed'
            : 'failed',
      exitCode,
    }
  }
  const ordered = Object.fromEntries(
    BUILD_COMMAND_IDS.map((id) => [id, results[id]]),
  )
  validateBuildCommandResults(ordered, false)
  return ordered
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const repeated = new Set()
  if (command === 'merge' || command === 'verify') {
    repeated.add('host-record')
  }
  if (command === 'record-build') repeated.add('command-result')
  const options = parseOptions(args, repeated)
  const commonOptions = new Set(['assets', 'package-manifest', 'output'])
  if (command === 'verify-transfer') {
    rejectUnknown(
      options,
      new Set(['assets', 'package-manifest', 'build-record']),
    )
    validateSupportedNodeVersion(process.version)
    const host = await inspectNativeHost()
    const { value: buildRecord } = await readCanonicalJson(
      resolve(requiredOption(options, 'build-record')),
      'native build record',
    )
    await verifyNativeTransfer({
      assetsDirectory: resolve(requiredOption(options, 'assets')),
      packageManifestPath: resolve(requiredOption(options, 'package-manifest')),
      buildRecord,
      host,
    })
    console.log(
      'Verified transferred artifacts against the native build record.',
    )
    return
  }
  if (command === 'record') {
    const outcomeOptions = new Set([
      'deb-smoke',
      'appimage-smoke',
      'package-inspection',
      'deb-normal-launch',
      'appimage-normal-launch',
      'pybrainage-provisioning',
      'pybrainage-readiness',
      'synthetic-output-reopen',
      'build-record',
    ])
    rejectUnknown(options, new Set([...commonOptions, ...outcomeOptions]))
    const { value: buildRecord } = await readCanonicalJson(
      resolve(requiredOption(options, 'build-record')),
      'native build record',
    )
    const record = await createNativeHostRecord({
      assetsDirectory: resolve(requiredOption(options, 'assets')),
      packageManifestPath: resolve(requiredOption(options, 'package-manifest')),
      buildRecord,
      results: {
        debSmoke: requiredOption(options, 'deb-smoke'),
        appImageSmoke: requiredOption(options, 'appimage-smoke'),
        packageInspection: requiredOption(options, 'package-inspection'),
        debNormalLaunch: requiredOption(options, 'deb-normal-launch'),
        appImageNormalLaunch: requiredOption(options, 'appimage-normal-launch'),
        pybrainageProvisioning: requiredOption(
          options,
          'pybrainage-provisioning',
        ),
        pybrainageReadiness: requiredOption(options, 'pybrainage-readiness'),
        syntheticOutputReopen: requiredOption(
          options,
          'synthetic-output-reopen',
        ),
      },
    })
    const output = resolve(requiredOption(options, 'output'))
    await writeCanonicalJson(output, record)
    console.log(`Recorded native acceptance evidence in ${basename(output)}.`)
    return
  }
  if (command === 'record-build') {
    rejectUnknown(options, new Set([...commonOptions, 'command-result']))
    const record = await createNativeBuildRecord({
      assetsDirectory: resolve(requiredOption(options, 'assets')),
      packageManifestPath: resolve(requiredOption(options, 'package-manifest')),
      commandResults: parseBuildCommandResultOptions(
        options.get('command-result'),
      ),
    })
    const output = resolve(requiredOption(options, 'output'))
    await writeCanonicalJson(output, record)
    console.log(`Recorded native build evidence in ${basename(output)}.`)
    return
  }
  if (command === 'merge' || command === 'verify') {
    const allowed = new Set([...commonOptions, 'build-record', 'host-record'])
    if (command === 'verify') allowed.add('acceptance')
    rejectUnknown(options, allowed)
    const recordPaths = options.get('host-record')
    if (!Array.isArray(recordPaths) || recordPaths.length !== 2) {
      throw new Error('Provide --host-record exactly twice.')
    }
    const hostRecords = await Promise.all(
      recordPaths.map(
        async (path) =>
          (
            await readCanonicalJson(
              resolve(path),
              'native host acceptance record',
            )
          ).value,
      ),
    )
    const { value: buildRecord } = await readCanonicalJson(
      resolve(requiredOption(options, 'build-record')),
      'native build record',
    )
    const input = {
      assetsDirectory: resolve(requiredOption(options, 'assets')),
      packageManifestPath: resolve(requiredOption(options, 'package-manifest')),
      buildRecord,
      hostRecords,
    }
    const expected = await createMergedReleaseAcceptance(input)
    if (command === 'merge') {
      const output = resolve(requiredOption(options, 'output'))
      await writeCanonicalJson(output, expected)
      console.log(`Merged native acceptance evidence in ${basename(output)}.`)
      return
    }
    if (options.has('output')) {
      throw new Error('Remove --output when verifying acceptance.')
    }
    const { value: actual } = await readCanonicalJson(
      resolve(requiredOption(options, 'acceptance')),
      'merged release acceptance record',
    )
    if (!same(actual, expected)) {
      throw new Error('Match merged acceptance to both canonical host records.')
    }
    validateMergedRecord(actual, actual.release?.version)
    console.log('Verified the native build and both Ubuntu acceptance records.')
    return
  }
  throw new Error(
    'Use release-acceptance.mjs record-build, verify-transfer, record, merge, or verify with explicit options.',
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
