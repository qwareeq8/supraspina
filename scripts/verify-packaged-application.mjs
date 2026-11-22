#!/usr/bin/env node
/** Verifies installer-contained notices, locks, provenance, and Electron terms. */

import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import {
  electronRuntimeLicenseContract,
  electronRuntimeVersion,
} from './generate-node-release-metadata.mjs'
import {
  createReleasePackageManifest,
  releasePackageManifestName,
} from './release-package-manifest.mjs'

const archiveSha =
  'd6f0c28a19bc71af119774f20d6b82be5d047d21ac78cbc168456c984c28dee7'
const maxTextBytes = 4 * 1024 * 1024
const expectedVersion = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version
const expectedThirdPartyProvenance = JSON.parse(
  await readFile(
    new URL('../THIRD_PARTY_PROVENANCE.json', import.meta.url),
    'utf8',
  ),
)
const publicSourcePaths = Object.freeze([
  'LICENSE',
  'THIRD_PARTY_NOTICES',
  'THIRD_PARTY_PROVENANCE.json',
  'licenses/FreeSurfer-Software-License-1.0.txt',
  'licenses/GPL-3.0.txt',
  'licenses/GUST-FONT-LICENSE.txt',
  'licenses/Lucide-ISC.txt',
  'licenses/MANIFEST-LM-Roman-Supraspina.txt',
  'licenses/micromamba-BSD-3-Clause.txt',
])
const expectedPublicFiles = Object.fromEntries(
  await Promise.all(
    publicSourcePaths.map(async (relativePath) => [
      relativePath,
      await sourceFileContract(new URL(`../${relativePath}`, import.meta.url)),
    ]),
  ),
)
const expectedMicromambaSha256 = Object.freeze({
  'linux-x86_64':
    expectedThirdPartyProvenance.generatedBinaryInputs.micromambaLinuxX64
      .sha256,
})
const expectedElectronRuntimeLicenses = electronRuntimeLicenseContract.map(
  ({ name, bytes, sha256 }) => ({ name, bytes, sha256 }),
)
const expectedPythonToolchain = JSON.parse(
  await readFile(
    new URL('../sidecar/requirements/release-toolchain.json', import.meta.url),
    'utf8',
  ),
)
const expectedScientificResourcePins = await sourceFileContract(
  new URL('../SCIENTIFIC_RESOURCE_PINS.json', import.meta.url),
)
const expectedPackageLock = await sourceFileContract(
  new URL('../package-lock.json', import.meta.url),
)
const expectedPythonReleaseLock = await sourceFileContract(
  new URL('../sidecar/requirements/release-linux-x86_64.txt', import.meta.url),
)
const expectedBrainFovHelper = await sourceFileContract(
  new URL('../sidecar/supraspina_sidecar/brainfov.py', import.meta.url),
)
const pyBrainAgeLockNames = Object.freeze([
  'cliffs-delta-requirements.txt',
  'pybrainage-linux-64.lock',
])
const expectedPyBrainAgeLocks = Object.fromEntries(
  await Promise.all(
    pyBrainAgeLockNames.map(async (name) => [
      name,
      await sourceFileContract(
        new URL(
          `../sidecar/supraspina_sidecar/pybrainage_locks/${name}`,
          import.meta.url,
        ),
      ),
    ]),
  ),
)

const brainChartsLockNames = Object.freeze([
  'braincharts-linux-64.lock',
  'braincharts-requirements.txt',
])
const expectedBrainChartsLocks = Object.fromEntries(
  await Promise.all(
    brainChartsLockNames.map(async (name) => [
      name,
      await sourceFileContract(
        new URL(
          `../sidecar/supraspina_sidecar/braincharts_locks/${name}`,
          import.meta.url,
        ),
      ),
    ]),
  ),
)

async function sourceFileContract(path) {
  const value = await readFile(path)
  return {
    bytes: value.length,
    sha256: createHash('sha256').update(value).digest('hex'),
  }
}

async function regular(path, label, { executable = false } = {}) {
  const info = await lstat(path)
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Provide ${label} as a nonempty regular file.`)
  }
  if (executable) await access(path, constants.X_OK)
  return info
}

async function boundedText(path, label) {
  const info = await regular(path, label)
  if (info.size > maxTextBytes)
    throw new Error(`Keep ${label} within the size bound.`)
  return readFile(path, 'utf8')
}

async function assertInside(root, child) {
  const rootReal = await realpath(root)
  const childReal = await realpath(child)
  if (childReal !== rootReal && !childReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error('Keep packaged resources within the application root.')
  }
}

async function assertExactEntries(path, expected, label) {
  const actual = (await readdir(path)).sort()
  const wanted = [...expected].sort()
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new Error(`Match the exact ${label} entries: ${wanted.join(', ')}.`)
  }
}

async function relativeFiles(root, current = root) {
  const result = []
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const child = join(current, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await relativeFiles(root, child)))
    } else if (entry.isFile()) {
      result.push(child.slice(root.length + 1).replaceAll('\\', '/'))
    } else {
      throw new Error(
        'Keep packaged resource inventories to files and directories.',
      )
    }
  }
  return result.sort()
}

function assertNoMachinePaths(value, label) {
  if (
    /(?:^|[\s"'(=])\/(?:home|data|Users|tmp)\//m.test(value) ||
    /\b[A-Za-z]:\\Users\\/i.test(value)
  ) {
    throw new Error(`Remove machine-local paths from ${label}.`)
  }
}

function sha512Hex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+=*)$/.exec(integrity)
  if (!match) return null
  return Buffer.from(match[1], 'base64').toString('hex')
}

async function exactContractFile(path, expected, label) {
  const info = await regular(path, label)
  if (info.size !== expected.bytes) {
    throw new Error(`Match the byte size for ${label}.`)
  }
  const value = await readFile(path)
  const sha256 = createHash('sha256').update(value).digest('hex')
  if (sha256 !== expected.sha256) {
    throw new Error(`Match the SHA-256 for ${label}.`)
  }
}

async function exactSha256File(path, expectedSha256, label) {
  await regular(path, label)
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`Provide a valid expected SHA-256 for ${label}.`)
  }
  const value = await readFile(path)
  const sha256 = createHash('sha256').update(value).digest('hex')
  if (sha256 !== expectedSha256) {
    throw new Error(`Match the SHA-256 for ${label}.`)
  }
}

async function assertNoManagedScientificRuntimeAssets(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = entry.name.toLowerCase()
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      if (name === 'scientific-resources') {
        throw new Error('Remove managed scientific resources from the bundle.')
      }
      await assertNoManagedScientificRuntimeAssets(child)
      continue
    }
    if (entry.isFile() && name.endsWith('.sif')) {
      throw new Error('Remove managed scientific resources from the bundle.')
    }
    if (entry.isFile() && name === 'license.txt') {
      throw new Error(
        'Remove the user-supplied FreeSurfer license from the bundle.',
      )
    }
  }
}

/**
 * Verify one packaged application against the release closure contract.
 *
 * @param {object} options
 * @param {string} options.applicationRoot - The unpacked application root.
 * @param {string} options.resourcesPath
 * @param {'linux-x86_64'} options.target
 * @param {ReadonlyArray<{name: string, bytes: number, sha256: string}>} [options.electronLicenseContract]
 * @param {Record<string, string>} [options.micromambaSha256Contract] -
 *   Micromamba digests by target.
 * @param {object} [options.releasePackageManifestContract] - The exact source
 *   identity expected in the package.
 * @returns {Promise<{target: string, publicNoticeFiles: number, nodePackages: number, pythonPackages: number, chromiumLicenseFiles: number}>}
 * @throws {Error} On missing, extra, unsafe, stale, or inconsistent package
 *   contents.
 */
export async function verifyPackagedApplication({
  applicationRoot,
  resourcesPath,
  target,
  electronLicenseContract = expectedElectronRuntimeLicenses,
  micromambaSha256Contract = expectedMicromambaSha256,
  releasePackageManifestContract,
}) {
  if (target !== 'linux-x86_64') {
    throw new Error('Use a supported package target.')
  }
  const applicationInfo = await lstat(applicationRoot)
  const resourcesInfo = await lstat(resourcesPath)
  if (!applicationInfo.isDirectory() || !resourcesInfo.isDirectory()) {
    throw new Error('Provide application and resources paths as directories.')
  }
  await assertInside(applicationRoot, resourcesPath)

  for (const relativePath of publicSourcePaths) {
    await exactContractFile(
      join(resourcesPath, relativePath),
      expectedPublicFiles[relativePath],
      relativePath,
    )
  }
  await assertExactEntries(
    join(resourcesPath, 'licenses'),
    publicSourcePaths
      .filter((path) => path.startsWith('licenses/'))
      .map((path) => basename(path)),
    'public license directory',
  )
  const notices = await boundedText(
    join(resourcesPath, 'THIRD_PARTY_NOTICES'),
    'third-party notices',
  )
  if (
    !notices.includes(archiveSha) ||
    !notices.includes('18 WebCM WOFF2 faces')
  ) {
    throw new Error('Describe the shipped closure in the third-party notices.')
  }

  const provenanceText = await boundedText(
    join(resourcesPath, 'THIRD_PARTY_PROVENANCE.json'),
    'third-party provenance',
  )
  const provenance = JSON.parse(provenanceText)
  if (
    provenance.schemaVersion !== 1 ||
    Object.keys(provenance.resourceFiles ?? {}).length !== 247 ||
    provenance.rendererFonts?.length !== 18 ||
    provenance.authoritativeEvidence?.upstreamBaseline?.sha256 !== archiveSha
  ) {
    throw new Error('Complete the third-party provenance inventory.')
  }

  const dependencyDirectory = join(resourcesPath, 'dependency-manifests')
  const expectedDependencyEntries = [
    'node-distributable.cyclonedx.json',
    'node-distributable.json',
    'node-third-party-notices.txt',
    'package-lock.json',
    `python-release-${target}-notices.txt`,
    `python-release-${target}.cyclonedx.json`,
    'python-locks',
    releasePackageManifestName,
  ]
  await assertExactEntries(
    dependencyDirectory,
    expectedDependencyEntries,
    'dependency-manifest directory',
  )
  await assertExactEntries(
    join(dependencyDirectory, 'python-locks'),
    [`release-${target}.txt`, 'release-toolchain.json'],
    'packaged Python lock directory',
  )
  const packageManifestText = await boundedText(
    join(dependencyDirectory, releasePackageManifestName),
    'release package manifest',
  )
  const packageManifest = JSON.parse(packageManifestText)
  const expectedPackageManifest =
    releasePackageManifestContract ?? (await createReleasePackageManifest())
  if (!isDeepStrictEqual(packageManifest, expectedPackageManifest)) {
    throw new Error('Match the exact release package manifest to this source.')
  }
  assertNoMachinePaths(packageManifestText, 'release package manifest')
  const nodeManifestText = await boundedText(
    join(dependencyDirectory, 'node-distributable.json'),
    'Node distributable manifest',
  )
  const nodeManifest = JSON.parse(nodeManifestText)
  await exactContractFile(
    join(dependencyDirectory, 'package-lock.json'),
    expectedPackageLock,
    'packaged Node lock',
  )
  await exactContractFile(
    join(dependencyDirectory, 'python-locks', `release-${target}.txt`),
    expectedPythonReleaseLock,
    'packaged Python release lock',
  )
  const packagedLockText = await boundedText(
    join(dependencyDirectory, 'package-lock.json'),
    'packaged Node lock',
  )
  const packagedLock = JSON.parse(packagedLockText)
  const expectedProductionRoots = Object.keys(
    packagedLock.packages?.['']?.dependencies ?? {},
  ).sort()
  const nodeRecordsMatchLock = nodeManifest.packages?.every((record) => {
    const locked = packagedLock.packages?.[record.lockPath]
    return (
      locked?.version === record.version &&
      locked?.license === record.license &&
      locked?.integrity === record.integrity
    )
  })
  if (
    nodeManifest.schemaVersion !== 1 ||
    nodeManifest.packageVersion !== expectedVersion ||
    nodeManifest.packageName !== packagedLock.packages?.['']?.name ||
    nodeManifest.sourceLock !== 'package-lock.json' ||
    !isDeepStrictEqual(nodeManifest.productionRoots, expectedProductionRoots) ||
    // The reviewed production closure plus the Electron runtime; packages
    // Vite inlines into the renderer bundle come on top of it.
    nodeManifest.packages?.filter(
      (record) => record.production || record.embeddedRuntime,
    ).length !== 19 ||
    !nodeManifest.packages.every(
      (record) =>
        record.production || record.embeddedRuntime || record.bundledInRenderer,
    ) ||
    !nodeRecordsMatchLock ||
    !expectedProductionRoots.every((name) =>
      nodeManifest.packages.some((record) => record.name === name),
    ) ||
    nodeManifest.embeddedElectron !== electronRuntimeVersion ||
    !isDeepStrictEqual(
      nodeManifest.electronRuntimeLicenses,
      electronLicenseContract,
    )
  ) {
    throw new Error('Complete the Node distributable manifest.')
  }
  const nodeSbomText = await boundedText(
    join(dependencyDirectory, 'node-distributable.cyclonedx.json'),
    'Node CycloneDX manifest',
  )
  const nodeSbom = JSON.parse(nodeSbomText)
  const nodeSbomComponents = new Map(
    nodeSbom.components?.map((component) => [component['bom-ref'], component]),
  )
  const nodeSbomMatchesManifest = nodeManifest.packages.every((record) => {
    const component = nodeSbomComponents.get(
      `npm:${record.lockPath}@${record.version}`,
    )
    return (
      component?.name === record.name &&
      component.version === record.version &&
      component.hashes?.length === 1 &&
      component.hashes[0]?.alg === 'SHA-512' &&
      component.hashes[0]?.content === sha512Hex(record.integrity) &&
      component.licenses?.length === 1 &&
      component.licenses[0]?.expression === record.license
    )
  })
  if (
    nodeSbom.bomFormat !== 'CycloneDX' ||
    nodeSbom.specVersion !== '1.6' ||
    nodeSbom.metadata?.component?.version !== expectedVersion ||
    nodeSbom.components?.length !== nodeManifest.packages.length ||
    !nodeSbomMatchesManifest ||
    !nodeSbom.components.some(
      (component) =>
        component.name === 'electron' &&
        component.version === electronRuntimeVersion,
    )
  ) {
    throw new Error('Complete the Node release SBOM.')
  }
  const pythonSbomText = await boundedText(
    join(dependencyDirectory, `python-release-${target}.cyclonedx.json`),
    'Python CycloneDX manifest',
  )
  const pythonSbom = JSON.parse(pythonSbomText)
  const pythonLockText = await boundedText(
    join(dependencyDirectory, 'python-locks', `release-${target}.txt`),
    'packaged Python release lock',
  )
  const lockedPythonPackages = new Map(
    [...pythonLockText.matchAll(/^([A-Za-z0-9_.-]+)==([^\s\\]+)\s*\\/gm)].map(
      ([, name, version]) => [name.toLowerCase().replaceAll('_', '-'), version],
    ),
  )
  const expectedPythonPackages = lockedPythonPackages.size
  const pythonComponents = new Map(
    pythonSbom.components?.map((component) => [
      component.name.toLowerCase().replaceAll('_', '-'),
      component.version,
    ]),
  )
  const pythonProperties = new Map(
    pythonSbom.metadata?.properties?.map((property) => [
      property.name,
      property.value,
    ]) ?? [],
  )
  const packagedToolchainText = await boundedText(
    join(dependencyDirectory, 'python-locks', 'release-toolchain.json'),
    'Python release toolchain',
  )
  const packagedToolchain = JSON.parse(packagedToolchainText)
  if (
    !isDeepStrictEqual(packagedToolchain, expectedPythonToolchain) ||
    pythonSbom.bomFormat !== 'CycloneDX' ||
    pythonSbom.specVersion !== '1.6' ||
    pythonSbom.metadata?.component?.version !== expectedVersion ||
    pythonProperties.get('supraspina:target') !== target ||
    pythonProperties.get('supraspina:python') !==
      expectedPythonToolchain.python ||
    pythonProperties.get('supraspina:lock-sha256') !==
      expectedPythonReleaseLock.sha256 ||
    pythonSbom.components?.length !== expectedPythonPackages ||
    ![...lockedPythonPackages].every(
      ([name, version]) => pythonComponents.get(name) === version,
    ) ||
    !pythonSbom.components.some(
      (component) =>
        component.name === 'openpyxl' && component.version === '3.1.5',
    )
  ) {
    throw new Error('Complete the Python release SBOM.')
  }
  for (const name of [
    'node-third-party-notices.txt',
    `python-release-${target}-notices.txt`,
    'package-lock.json',
    join('python-locks', `release-${target}.txt`),
  ]) {
    const value = await boundedText(join(dependencyDirectory, name), name)
    assertNoMachinePaths(value, name)
  }
  assertNoMachinePaths(nodeManifestText, 'Node distributable manifest')
  assertNoMachinePaths(nodeSbomText, 'Node release SBOM')
  assertNoMachinePaths(pythonSbomText, 'Python release SBOM')
  assertNoMachinePaths(packagedToolchainText, 'Python release toolchain')

  const runtime = join(resourcesPath, 'sidecar', 'supraspina-runtime')
  await assertExactEntries(
    join(resourcesPath, 'sidecar'),
    ['supraspina-runtime', 'supraspina-sidecar'],
    'frozen-sidecar directory',
  )
  const pyBrainAgeLocks = join(runtime, 'pybrainage-locks')
  await assertExactEntries(
    pyBrainAgeLocks,
    pyBrainAgeLockNames,
    'frozen PyBrainAge lock directory',
  )
  for (const name of pyBrainAgeLockNames) {
    await exactContractFile(
      join(pyBrainAgeLocks, name),
      expectedPyBrainAgeLocks[name],
      `frozen PyBrainAge lock ${name}`,
    )
  }
  const brainChartsLocks = join(runtime, 'braincharts-locks')
  await assertExactEntries(
    brainChartsLocks,
    brainChartsLockNames,
    'frozen BrainCharts lock directory',
  )
  for (const name of brainChartsLockNames) {
    await exactContractFile(
      join(brainChartsLocks, name),
      expectedBrainChartsLocks[name],
      `frozen BrainCharts lock ${name}`,
    )
  }
  await exactContractFile(
    join(runtime, 'metadata', 'THIRD_PARTY_PROVENANCE.json'),
    expectedPublicFiles['THIRD_PARTY_PROVENANCE.json'],
    'frozen-sidecar acquisition metadata',
  )
  const bundledResources = Object.entries(
    expectedThirdPartyProvenance.resourceFiles,
  ).filter(([, record]) => record.delivery === 'bundled')
  const expectedRuntimeResources = [
    ...bundledResources.map(([path]) => path.slice('resources/'.length)),
    'brainfov/brainfov_helper.py',
  ].sort()
  const runtimeResources = join(runtime, 'resources')
  for (const excluded of [
    join('resources', 'enigma', 'compiled', 'FS_external_QC'),
    join('resources', 'features', 'rois_input_template.txt'),
  ]) {
    try {
      await lstat(join(runtime, excluded))
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    throw new Error(
      `Remove the unlicensed upstream asset from redistribution: ${excluded}.`,
    )
  }
  if (
    !isDeepStrictEqual(
      await relativeFiles(runtimeResources),
      expectedRuntimeResources,
    )
  ) {
    throw new Error('Match the exact frozen scientific-resource inventory.')
  }
  for (const [relativePath, record] of bundledResources) {
    await exactSha256File(
      join(runtime, relativePath),
      record.sha256,
      relativePath,
    )
  }
  await exactContractFile(
    join(runtime, 'metadata', 'SCIENTIFIC_RESOURCE_PINS.json'),
    expectedScientificResourcePins,
    'scientific resource pin manifest',
  )
  await exactContractFile(
    join(runtime, 'resources', 'brainfov', 'brainfov_helper.py'),
    expectedBrainFovHelper,
    'brain-FOV helper',
  )
  await assertNoManagedScientificRuntimeAssets(applicationRoot)
  await regular(
    join(resourcesPath, 'sidecar', 'supraspina-sidecar'),
    'frozen sidecar',
    { executable: true },
  )
  const micromambaPath = join(resourcesPath, 'micromamba', 'micromamba')
  await assertExactEntries(
    join(resourcesPath, 'micromamba'),
    ['micromamba'],
    'micromamba directory',
  )
  await regular(micromambaPath, 'bundled micromamba', { executable: true })
  await exactSha256File(
    micromambaPath,
    micromambaSha256Contract[target],
    'bundled micromamba',
  )

  const electronLicenseDirectory = applicationRoot
  for (const expected of electronLicenseContract) {
    if (!/^[A-Za-z0-9._-]+$/.test(expected.name)) {
      throw new Error('Use a safe Electron runtime license filename.')
    }
    await exactContractFile(
      join(electronLicenseDirectory, expected.name),
      expected,
      `Electron runtime license ${expected.name}`,
    )
  }
  return {
    target,
    publicNoticeFiles: publicSourcePaths.length,
    nodePackages: nodeManifest.packages.length,
    pythonPackages: pythonSbom.components.length,
    chromiumLicenseFiles: 1,
  }
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || !value)
      throw new Error('Provide valid arguments.')
    values[flag.slice(2)] = resolve(value)
  }
  if (!values['application-root'] || !values.resources || !values.target) {
    throw new Error(
      'Use verify-packaged-application.mjs --application-root <dir> --resources <dir> --target <target>.',
    )
  }
  return {
    applicationRoot: values['application-root'],
    resourcesPath: values.resources,
    target: basename(values.target),
  }
}

async function main() {
  const result = await verifyPackagedApplication(
    parseArguments(process.argv.slice(2)),
  )
  console.log(
    `Verified the packaged ${result.target} application: ` +
      `${result.nodePackages} Node/Electron and ${result.pythonPackages} Python packages.`,
  )
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main()
}
