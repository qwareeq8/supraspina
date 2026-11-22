#!/usr/bin/env node
/** Builds the deterministic source identity embedded in every Linux package. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const expectedRepository = 'qwareeq8/supraspina'
const expectedRepositoryUrl = `https://github.com/${expectedRepository}`
const fullObjectId = /^[0-9a-f]{40}$/

/** The package-embedded release source identity filename. */
export const releasePackageManifestName = 'release-package-manifest.json'
/** The generated metadata directory that electron-builder copies into packages. */
export const stagedReleaseMetadataPath =
  'build/release-metadata/dependency-manifests'

/** The explicit configuration and lock inputs recorded in the package. */
export const releasePackageInputPaths = Object.freeze([
  'CITATION.cff',
  'SCIENTIFIC_RESOURCE_PINS.json',
  'THIRD_PARTY_PROVENANCE.json',
  'electron-builder.yml',
  'electron.vite.config.ts',
  'package-lock.json',
  'package.json',
  'scripts/app-version.mjs',
  'scripts/build-identity.mjs',
  'scripts/build-sidecar.sh',
  'scripts/bundled-packages.mjs',
  'scripts/check-github-release-settings.mjs',
  'scripts/check-release.mjs',
  'scripts/generate-node-release-metadata.mjs',
  'scripts/inspect-linux-packages.mjs',
  'scripts/package-smoke.mjs',
  'scripts/release-acceptance.mjs',
  'scripts/release-acceptance.schema.json',
  'scripts/release-assets.mjs',
  'scripts/release-package-manifest.mjs',
  'scripts/smoke-appimage.sh',
  'scripts/smoke-installed-deb.sh',
  'scripts/stage-sidecar-resources.mjs',
  'scripts/stamp-version.mjs',
  'scripts/verify-packaged-application.mjs',
  'sidecar/pyproject.toml',
  'sidecar/requirements/release-linux-x86_64.txt',
  'sidecar/requirements/release-toolchain.json',
  'sidecar/requirements/toolchain.txt',
  'sidecar/scripts/generate_release_metadata.py',
  'sidecar/supraspina-sidecar.spec',
  'sidecar/supraspina_sidecar/braincharts_locks/braincharts-linux-64.lock',
  'sidecar/supraspina_sidecar/braincharts_locks/braincharts-requirements.txt',
  'sidecar/supraspina_sidecar/pybrainage_locks/cliffs-delta-requirements.txt',
  'sidecar/supraspina_sidecar/pybrainage_locks/pybrainage-linux-64.lock',
  'sidecar/uv.lock',
])

function captureGit(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function captureGitNul(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean)
}

function defaultGitState() {
  return {
    repositoryUrl: captureGit('remote', 'get-url', 'origin'),
    commit: captureGit('rev-parse', '--verify', 'HEAD'),
    tree: captureGit('rev-parse', '--verify', 'HEAD^{tree}'),
    changedPaths: [
      ...captureGitNul('diff', '--name-only', '-z', 'HEAD'),
      ...captureGitNul('diff', '--cached', '--name-only', '-z', 'HEAD'),
      ...captureGitNul('ls-files', '--others', '--exclude-standard', '-z'),
    ],
  }
}

function normalizeRepository(value) {
  if (typeof value !== 'string') return ''
  const url = value.replace(/^git\+/, '')
  if (url.startsWith('git@github.com:')) {
    return url.slice('git@github.com:'.length).replace(/\.git$/, '')
  }
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') return ''
    return parsed.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '')
  } catch {
    return ''
  }
}

async function fileIdentity(relativePath) {
  const path = join(root, relativePath)
  const info = await lstat(path)
  if (!info.isFile() || info.size === 0) {
    throw new Error(
      `Provide the release package input as a nonempty regular file: ${relativePath}.`,
    )
  }
  const value = await readFile(path)
  return {
    bytes: value.length,
    sha256: createHash('sha256').update(value).digest('hex'),
  }
}

/**
 * Create the exact clean-source identity embedded in Linux packages.
 *
 * @param {object} [options] - Deterministic inputs for tests.
 * @param {object} [options.gitState]
 * @returns {Promise<object>}
 * @throws {Error} On a dirty tree, wrong repository, abbreviated object ID, or
 *   inconsistent version.
 */
export async function createReleasePackageManifest({
  gitState = defaultGitState(),
} = {}) {
  if (
    normalizeRepository(gitState.repositoryUrl) !== expectedRepository ||
    !fullObjectId.test(gitState.commit ?? '') ||
    !fullObjectId.test(gitState.tree ?? '')
  ) {
    throw new Error(
      `Bind the package to full object IDs from ${expectedRepositoryUrl}.`,
    )
  }
  if (
    !Array.isArray(gitState.changedPaths) ||
    gitState.changedPaths.some(
      (relativePath) =>
        typeof relativePath !== 'string' || relativePath.length === 0,
    )
  ) {
    throw new Error('Inspect every changed source path before packaging.')
  }
  const changedPaths = [...new Set(gitState.changedPaths)].sort()
  if (changedPaths.length > 0) {
    throw new Error(
      `Generate package metadata from a clean source tree: ${changedPaths.join(', ')}.`,
    )
  }

  const [packageJson, packageLock, toolchain, provenance, sidecarProject] =
    await Promise.all([
      readFile(join(root, 'package.json'), 'utf8').then(JSON.parse),
      readFile(join(root, 'package-lock.json'), 'utf8').then(JSON.parse),
      readFile(
        join(root, 'sidecar', 'requirements', 'release-toolchain.json'),
        'utf8',
      ).then(JSON.parse),
      readFile(join(root, 'THIRD_PARTY_PROVENANCE.json'), 'utf8').then(
        JSON.parse,
      ),
      readFile(join(root, 'sidecar', 'pyproject.toml'), 'utf8'),
    ])
  const version = packageJson.version
  const tag = `v${version}`
  const sidecarVersion = /^version = "([^"]+)"$/m.exec(sidecarProject)?.[1]
  const pyinstallerVersion = /^freeze = \["pyinstaller==([^"]+)"\]$/m.exec(
    sidecarProject,
  )?.[1]
  if (
    packageJson.name !== 'supraspina' ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version ?? '') ||
    packageLock.version !== version ||
    packageLock.packages?.['']?.version !== version ||
    sidecarVersion !== version ||
    normalizeRepository(packageJson.repository?.url) !== expectedRepository
  ) {
    throw new Error(
      'Match the package, lock, sidecar, and repository release identity.',
    )
  }

  const inputs = Object.fromEntries(
    await Promise.all(
      releasePackageInputPaths.map(async (relativePath) => [
        relativePath,
        await fileIdentity(relativePath),
      ]),
    ),
  )
  const micromamba = provenance.generatedBinaryInputs?.micromambaLinuxX64
  if (
    typeof packageJson.engines?.node !== 'string' ||
    packageJson.devDependencies?.electron !==
      packageLock.packages?.['']?.devDependencies?.electron ||
    packageJson.devDependencies?.['electron-builder'] !==
      packageLock.packages?.['']?.devDependencies?.['electron-builder'] ||
    packageJson.devDependencies?.['electron-vite'] !==
      packageLock.packages?.['']?.devDependencies?.['electron-vite'] ||
    !/^\d+\.\d+\.\d+$/.test(toolchain.python ?? '') ||
    !/^\d+\.\d+\.\d+$/.test(toolchain.pip ?? '') ||
    !/^\d+\.\d+\.\d+$/.test(pyinstallerVersion ?? '') ||
    !/^\d+(?:\.\d+)*-\d+$/.test(micromamba?.release ?? '') ||
    !/^[0-9a-f]{64}$/.test(micromamba?.sha256 ?? '')
  ) {
    throw new Error('Complete the reviewed Linux release toolchain identity.')
  }

  return {
    schemaVersion: 1,
    package: {
      name: packageJson.name,
      productName: 'Supraspina',
      version,
      tag,
      target: 'linux-x86_64',
    },
    source: {
      repository: expectedRepositoryUrl,
      commit: gitState.commit,
      tree: gitState.tree,
      clean: true,
    },
    build: {
      nodeEngine: packageJson.engines?.node,
      python: toolchain.python,
      pip: toolchain.pip,
      electron: packageJson.devDependencies?.electron,
      electronBuilder: packageJson.devDependencies?.['electron-builder'],
      electronVite: packageJson.devDependencies?.['electron-vite'],
      pyinstaller: pyinstallerVersion,
      micromambaRelease: micromamba.release,
      micromambaSha256: micromamba.sha256,
    },
    signing: {
      decision: 'unsigned',
      reasonCode: 'no-linux-package-signing-identity',
      artifacts: {
        AppImage: 'unsigned',
        deb: 'unsigned',
      },
    },
    inputs,
  }
}

function describeManifest(manifest) {
  const version = manifest?.package?.version
  const commit = manifest?.source?.commit
  if (typeof version !== 'string' || typeof commit !== 'string') {
    return 'no readable release package manifest'
  }
  return `the release package manifest of ${version} at ${commit.slice(0, 12)}`
}

async function describeSource(gitState) {
  const { version } = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  )
  const changes =
    gitState.changedPaths?.length > 0 ? ' with uncommitted changes' : ''
  return `${version} at ${String(gitState.commit).slice(0, 12)}${changes}`
}

/**
 * Check that staged release metadata describes the source being packaged.
 *
 * electron-builder copies the staged directory into every package, and the
 * directory outlives the release build that generated it, so a later package
 * would otherwise carry release metadata for another version or commit.
 *
 * @param {object} [options] - Deterministic inputs for tests.
 * @param {string} [options.directory]
 * @param {object} [options.gitState]
 * @returns {Promise<{staged: boolean}>} Whether metadata is staged.
 * @throws {Error} On staged metadata without the release package manifest of
 *   this exact clean source.
 */
export async function checkStagedReleaseMetadata({
  directory = join(root, stagedReleaseMetadataPath),
  gitState,
} = {}) {
  let info
  try {
    info = await lstat(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return { staged: false }
    throw error
  }
  if (!info.isDirectory()) {
    throw new Error(
      `Provide the staged release metadata as a real directory: ${stagedReleaseMetadataPath}.`,
    )
  }
  const state = gitState ?? defaultGitState()
  let staged = null
  try {
    staged = JSON.parse(
      await readFile(join(directory, releasePackageManifestName), 'utf8'),
    )
  } catch {
    // Report a missing or unparsable manifest as stale metadata below.
  }
  let expected = null
  try {
    expected = await createReleasePackageManifest({ gitState: state })
  } catch {
    // A source without a release identity, such as one with uncommitted
    // changes, matches no staged metadata.
  }
  if (expected === null || !isDeepStrictEqual(staged, expected)) {
    throw new Error(
      `Remove the stale release metadata before packaging: ${stagedReleaseMetadataPath} holds ${describeManifest(staged)}, and this source is ${await describeSource(state)}.`,
    )
  }
  return { staged: true }
}

async function main(argv) {
  if (argv.length !== 1 || argv[0] !== 'check-staged') {
    throw new Error('Use release-package-manifest.mjs check-staged.')
  }
  const { staged } = await checkStagedReleaseMetadata()
  console.log(
    staged
      ? 'Verified that the staged release metadata describes this source.'
      : 'No release metadata is staged; the package will carry no generated dependency metadata or release package manifest.',
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2))
}
