#!/usr/bin/env node
/** Verifies Supraspina release metadata and optional tag publication authority. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { load as loadYaml } from 'js-yaml'

import {
  appVersionDate,
  compareAppVersions,
  parseAppVersion,
} from './app-version.mjs'
import { expectedAssetNames, verifyChecksums } from './release-assets.mjs'
import { readVersionFields } from './stamp-version.mjs'

const root = new URL('../', import.meta.url)
const EXPECTED_REPOSITORY = 'qwareeq8/supraspina'
const EXPECTED_REPOSITORY_URL = `https://github.com/${EXPECTED_REPOSITORY}`
const [EXPECTED_OWNER, EXPECTED_REPOSITORY_NAME] =
  EXPECTED_REPOSITORY.split('/')

/**
 * Resolve the repository whose refs authorize a strict release.
 *
 * `SUPRASPINA_RELEASE_REPOSITORY` lets a disposable rehearsal repository run
 * the exact workflow; the packaged metadata still names the real repository.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 * @throws {Error} On an override that is not an owner/name pair.
 */
export function releaseAuthority(env) {
  const override = env.SUPRASPINA_RELEASE_REPOSITORY
  if (!override) return EXPECTED_REPOSITORY
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(override)) {
    throw new Error(
      `Set SUPRASPINA_RELEASE_REPOSITORY to an owner/name pair, found ${override}.`,
    )
  }
  return override
}

/**
 * The reviewed product identity, branding, and Linux packaging contract.
 * Treat every entry as a release gate rather than a default.
 */
export const RELEASE_CONTRACT = Object.freeze({
  appId: 'io.github.qwareeq8.supraspina',
  productName: 'Supraspina',
  packageName: 'supraspina',
  researchDescription:
    'Supraspina is a Linux desktop research console for a 14-stage structural-MRI workflow.',
  linuxSynopsis:
    'Research workflow console for the Supraspina structural-MRI pipeline',
  desktopName: 'supraspina.desktop',
  author: 'Yusuf Qwareeq',
  email: 'yusuf@qwareeq.com',
  copyright: 'Copyright (c) 2026 Yusuf Qwareeq',
  homepage: 'https://qwareeq.com/',
  repositoryUrl: EXPECTED_REPOSITORY_URL,
  linuxCategory: 'Science',
  debianSection: 'science',
  debianPriority: 'optional',
  appImageToolset: '1.0.3',
  linuxTargets: Object.freeze(['AppImage', 'deb']),
  outputDirectory: 'release',
  packagedFiles: Object.freeze(['out/**/*', '!**/*.map']),
  publish: Object.freeze({
    provider: 'github',
    owner: EXPECTED_OWNER,
    repo: EXPECTED_REPOSITORY_NAME,
  }),
})

/** The complete reviewed Debian runtime dependency contract. */
export const REQUIRED_DEB_DEPENDENCIES = Object.freeze([
  'libasound2t64 | libasound2',
  'libgbm1',
  'libgtk-3-0',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0',
  'xdg-utils',
])

/** The exact generated metadata files embedded by electron-builder. */
export const GENERATED_RELEASE_METADATA_NAMES = Object.freeze([
  'node-distributable.cyclonedx.json',
  'node-distributable.json',
  'node-third-party-notices.txt',
  'python-release-linux-x86_64.cyclonedx.json',
  'python-release-linux-x86_64-notices.txt',
  'release-package-manifest.json',
])

/**
 * The reviewed SHA-256 digest of every committed brand asset. Regenerate
 * these digests only together with the artwork they describe.
 */
export const BRAND_ASSET_DIGESTS = Object.freeze({
  'packaging/icon.png':
    '8b5ed1c768e00352ed6175a273af63c9fb33ec2a83b731b7314577b2f4b6373e',
  'src/renderer/assets/brand/supraspina_icon.svg':
    '12fe4431f3861e55eff2415dd7257b4d37d3c79cd1244297074e8b380d052d94',
})

/** Every packaging key that would reintroduce a non-Linux target. */
const FORBIDDEN_BUILDER_KEYS = Object.freeze([
  'mac',
  'mas',
  'dmg',
  'pkg',
  'win',
  'nsis',
  'msi',
  'appx',
  'portable',
])

async function text(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8')
}

async function digest(relativePath) {
  const value = await readFile(new URL(relativePath, root))
  return createHash('sha256').update(value).digest('hex')
}

async function entryNames(relativePath) {
  return (await readdir(new URL(relativePath, root))).sort()
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function captureGit(...args) {
  return capture('git', args)
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

function gitIsAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: root,
      stdio: 'ignore',
    })
    return true
  } catch (error) {
    if (error?.status === 1) return false
    throw error
  }
}

/**
 * Require the UTC date-time machine form for a release version.
 *
 * @param {string} version
 * @throws {Error} On any other version form.
 */
export function requireAppVersion(version) {
  if (!parseAppVersion(version)) {
    throw new Error(
      `Use a YYYYMMDD.HHMM.0 UTC date-time version without leading zeros in HHMM; run npm run version:stamp: ${version}.`,
    )
  }
}

/**
 * Verify that every stamped field carries one version and its release date.
 *
 * @param {Array<{path: string, kind: string, value: string}>} fields - The
 *   stamped fields that `readVersionFields` returns.
 * @returns {string} The agreed machine-form version.
 * @throws {Error} On an invalid version, a disagreeing field, or a release date
 *   other than the date the version names.
 */
export function validateVersionAgreement(fields) {
  const versions = fields.filter((field) => field.kind === 'version')
  const version = versions[0]?.value
  requireAppVersion(version)
  const stale = versions.find((field) => field.value !== version)
  if (stale) {
    throw new Error(
      `Match the version in ${stale.path} to ${version}; run npm run version:stamp.`,
    )
  }
  const date = appVersionDate(version)
  const staleDate = fields.find(
    (field) => field.kind === 'date' && field.value !== date,
  )
  if (staleDate) {
    throw new Error(
      `Match the release date in ${staleDate.path} to ${date}, the date of ${version}; run npm run version:stamp.`,
    )
  }
  return version
}

/**
 * Verify the committed sidecar-build and local package-smoke contracts.
 *
 * @param {object} sources - The source text of each packaging file.
 * @param {string} sources.buildSidecar
 * @param {string} sources.sidecarSpec
 * @param {string} sources.smokeAppImage
 * @param {string} sources.smokeDebian
 * @throws {Error} On an unreviewable build or weakened local sandbox.
 */
export function validatePackagingContract({
  buildSidecar,
  sidecarSpec,
  smokeAppImage,
  smokeDebian = '',
}) {
  const buildsFromCommittedSpec =
    buildSidecar.includes('SUPRASPINA_PYINSTALLER_STAGING="${staging_dir}"') &&
    buildSidecar.includes('"${sidecar_dir}/supraspina-sidecar.spec"')
  const longCommandOptions =
    /--(?:add-data|collect-all|collect-submodules|exclude-module|onedir|specpath)\b/
  if (!buildsFromCommittedSpec || longCommandOptions.test(buildSidecar)) {
    throw new Error(
      'Build the frozen sidecar from its committed PyInstaller spec.',
    )
  }
  const cleanSidecarStaging = [
    'readonly owned_output_paths=(',
    '"${sidecar_dir}/build"',
    '"${sidecar_dir}/dist"',
    '"${out_dir}"',
    'mkdir "${out_dir}"',
    'find "${out_dir}" -mindepth 1 -maxdepth 1',
  ].every((value) => buildSidecar.includes(value))
  if (
    !cleanSidecarStaging ||
    buildSidecar.includes('mkdir -p "${out_dir}"') ||
    buildSidecar.includes('rm -rf "${out_dir}')
  ) {
    throw new Error(
      'Require absent, exact ignored staging for every frozen-sidecar build.',
    )
  }

  const requiredSpecPatterns = [
    /SUPRASPINA_PYINSTALLER_STAGING/,
    /collect_submodules\(["']supraspina_sidecar["']\)/,
    /["']numpy["']/,
    /["']openpyxl["']/,
    /["']pydantic["']/,
    /excludes=\[["']tkinter["']\]/,
    /contents_directory=["']supraspina-runtime["']/,
  ]
  if (
    !requiredSpecPatterns.every((pattern) => pattern.test(sidecarSpec)) ||
    sidecarSpec.includes('upx=True') ||
    (sidecarSpec.match(/upx=False/g) ?? []).length !== 2
  ) {
    throw new Error(
      'Declare the reviewed sidecar imports, data, exclusions, layout, and disabled UPX state in the PyInstaller spec.',
    )
  }
  // Reject the flag and both environment opt-ins that reach the CI-only escape.
  const sandboxEscapes = [
    '--no-sandbox',
    'SUPRASPINA_SMOKE_NO_SANDBOX',
    'SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX',
  ]
  const weakened = [smokeAppImage, smokeDebian].some((script) =>
    sandboxEscapes.some((escape) => script.includes(escape)),
  )
  if (weakened) {
    throw new Error(
      'Keep the Chromium sandbox enabled during local package smoke tests.',
    )
  }
  // Require both smoke scripts to inspect the artifact they just exercised.
  const inspects = [smokeAppImage, smokeDebian].every((script) =>
    script.includes('inspect-linux-packages.mjs'),
  )
  if (!inspects) {
    throw new Error(
      'Inspect the final launcher metadata and sandbox policy from every package smoke script.',
    )
  }
  const installsDebAlone =
    /^if sudo apt-get install --yes "\$\{deb\}"; then$/m.test(smokeDebian) &&
    !/apt-get install --yes[^\n]*(?:xvfb[^\n]*\$\{deb\}|\$\{deb\}[^\n]*xvfb)/.test(
      smokeDebian,
    )
  const installedDebianChecks = [
    'dpkg-query --listfiles "${package_name}"',
    'sudo apt-get check',
    'ldd "${path}"',
    '--native-science',
    'sudo apt-get purge --yes "${package_name}"',
    'Purge left the package-owned path',
  ].every((value) => smokeDebian.includes(value))
  if (!installsDebAlone || !installedDebianChecks) {
    throw new Error(
      'Install the Debian artifact alone, verify dependencies and ELFs, then prove purge cleanup.',
    )
  }
}

/**
 * Verify the exact generated metadata copied into every packaged application.
 *
 * @param {object} builder - The parsed electron-builder configuration.
 * @throws {Error} On wildcard, missing, extra, or redirected metadata staging.
 */
export function validateReleaseMetadataPackaging(builder) {
  const entries = builder.extraResources ?? []
  const generated = entries.filter(
    (entry) => entry.from === 'build/release-metadata/dependency-manifests',
  )
  const packageLock = entries.filter(
    (entry) => entry.from === 'package-lock.json',
  )
  const pythonLocks = entries.filter(
    (entry) => entry.from === 'sidecar/requirements',
  )
  if (
    generated.length !== 1 ||
    generated[0].to !== 'dependency-manifests' ||
    !isDeepStrictEqual(
      [...(generated[0].filter ?? [])].sort(),
      [...GENERATED_RELEASE_METADATA_NAMES].sort(),
    ) ||
    packageLock.length !== 1 ||
    packageLock[0].to !== 'dependency-manifests/package-lock.json' ||
    pythonLocks.length !== 1 ||
    pythonLocks[0].to !== 'dependency-manifests/python-locks' ||
    !isDeepStrictEqual([...(pythonLocks[0].filter ?? [])].sort(), [
      'release-linux-x86_64.txt',
      'release-toolchain.json',
    ])
  ) {
    throw new Error(
      'Embed exactly the reviewed release metadata, package lock, and Python locks.',
    )
  }
}

/**
 * Verify the packaged bundle layout and the GitHub release coordinates.
 *
 * @param {object} builder - The parsed electron-builder configuration.
 * @throws {Error} On an unpacked bundle, an unreviewed packaged file list, a
 *   moved output directory, or foreign publish coordinates.
 */
export function validatePackagingLayout(builder) {
  if (builder.asar !== true) {
    throw new Error('Pack the built application into an asar archive.')
  }
  if (!isDeepStrictEqual(builder.files, [...RELEASE_CONTRACT.packagedFiles])) {
    throw new Error(
      'Package exactly the reviewed build output and no source maps.',
    )
  }
  if (builder.directories?.output !== RELEASE_CONTRACT.outputDirectory) {
    throw new Error(
      `Write packaged artifacts to ${RELEASE_CONTRACT.outputDirectory}/, where the release procedure reads them.`,
    )
  }
  if (!isDeepStrictEqual(builder.publish, { ...RELEASE_CONTRACT.publish })) {
    throw new Error(
      `Publish to ${RELEASE_CONTRACT.publish.owner}/${RELEASE_CONTRACT.publish.repo} through the ${RELEASE_CONTRACT.publish.provider} provider.`,
    )
  }
}

/**
 * Verify that the product ships Linux artifacts and nothing else.
 *
 * @param {object} sources
 * @param {object} sources.packageJson - The parsed package manifest.
 * @param {object} sources.builder - The parsed electron-builder configuration.
 * @param {object} sources.pythonToolchain - The parsed Python release
 *   toolchain.
 * @param {string[]} sources.requirementNames - The Python requirement
 *   filenames.
 * @param {string[]} sources.scriptNames - The repository script filenames.
 * @param {string} sources.version
 * @throws {Error} On a Mac script, Mac configuration, Mac lock, DMG asset, or
 *   non-Linux target.
 */
export function validateLinuxOnlyRelease({
  packageJson,
  builder,
  pythonToolchain,
  requirementNames,
  scriptNames,
  version,
}) {
  const scripts = packageJson.scripts ?? {}
  const nonLinuxScript = Object.entries(scripts).find(
    ([name, command]) =>
      /(?::|-)(?:mac|macos|darwin|win|windows)\b/.test(name) ||
      /--(?:mac|win|universal)\b/.test(String(command)),
  )
  if (nonLinuxScript) {
    throw new Error(
      `Remove the non-Linux package script: ${nonLinuxScript[0]}.`,
    )
  }
  if (
    typeof scripts['package:linux'] !== 'string' ||
    !/electron-builder --linux --publish never(?:\s|$)/.test(
      scripts['package:linux'],
    )
  ) {
    throw new Error(
      'Keep local Linux packaging publication-inert with --publish never.',
    )
  }
  const forbiddenKey = FORBIDDEN_BUILDER_KEYS.find((key) => key in builder)
  if (forbiddenKey) {
    throw new Error(
      `Remove the non-Linux electron-builder section: ${forbiddenKey}.`,
    )
  }
  const targets = builder.linux?.target ?? []
  if (
    JSON.stringify([...targets].sort()) !==
    JSON.stringify([...RELEASE_CONTRACT.linuxTargets].sort())
  ) {
    throw new Error('Build exactly the AppImage and Debian Linux targets.')
  }
  const nonLinuxLock = requirementNames.find(
    (name) =>
      /^release-.*\.txt$/.test(name) && name !== 'release-linux-x86_64.txt',
  )
  if (nonLinuxLock) {
    throw new Error(
      `Remove the non-Linux Python release lock: ${nonLinuxLock}.`,
    )
  }
  const nonLinuxSmoke = scriptNames.find((name) =>
    /(?:macos|darwin|windows)/i.test(name),
  )
  if (nonLinuxSmoke) {
    throw new Error(`Remove the non-Linux release script: ${nonLinuxSmoke}.`)
  }
  const targetNames = Object.keys(pythonToolchain.targets ?? {})
  if (targetNames.length !== 1 || targetNames[0] !== 'linux-x86_64') {
    throw new Error('Declare only the linux-x86_64 Python release target.')
  }
  const nonLinuxAsset = expectedAssetNames(version).find((name) =>
    /\.(?:dmg|pkg|exe|msi|zip)$/.test(name),
  )
  if (nonLinuxAsset) {
    throw new Error(`Remove the non-Linux release asset: ${nonLinuxAsset}.`)
  }
}

/**
 * Verify the first-party product identity, branding, and Linux launcher fields.
 *
 * @param {object} sources
 * @param {object} sources.packageJson - The parsed package manifest.
 * @param {object} sources.builder - The parsed electron-builder configuration.
 * @param {Record<string, string>} sources.brandDigests - The committed
 *   brand-asset digests.
 * @throws {Error} On stale product identity, contact metadata, or brand
 *   artwork.
 */
export function validateProductIdentity({
  packageJson,
  builder,
  brandDigests,
}) {
  const expected = RELEASE_CONTRACT
  if (
    packageJson.name !== expected.packageName ||
    packageJson.description !== expected.researchDescription ||
    packageJson.desktopName !== expected.desktopName ||
    packageJson.author?.name !== expected.author ||
    packageJson.author?.email !== expected.email ||
    packageJson.homepage !== expected.homepage ||
    packageJson.repository?.url !== `git+${expected.repositoryUrl}.git` ||
    packageJson.bugs?.url !== `${expected.repositoryUrl}/issues`
  ) {
    throw new Error('Use the reviewed first-party package identity.')
  }
  if (
    builder.appId !== expected.appId ||
    builder.productName !== expected.productName ||
    builder.linux?.synopsis !== expected.linuxSynopsis ||
    builder.copyright !== expected.copyright ||
    builder.linux?.category !== expected.linuxCategory ||
    builder.linux?.maintainer !== `${expected.author} <${expected.email}>` ||
    builder.linux?.vendor !== expected.author ||
    builder.linux?.syncDesktopName !== true ||
    builder.deb?.packageCategory !== expected.debianSection ||
    builder.deb?.priority !== expected.debianPriority
  ) {
    throw new Error('Use the reviewed packaged product identity.')
  }
  const iconResource = (builder.extraResources ?? []).some(
    (entry) => entry?.from === 'packaging/icon.png' && entry?.to === 'icon.png',
  )
  if (
    builder.directories?.buildResources !== 'packaging' ||
    !iconResource ||
    builder.linux?.icon !== 'packaging/icons'
  ) {
    throw new Error('Ship the canonical mark as the packaged resource icon.')
  }
  const staleAsset = Object.keys(BRAND_ASSET_DIGESTS).find(
    (name) => brandDigests[name] !== BRAND_ASSET_DIGESTS[name],
  )
  const expectedAssetCount = Object.keys(BRAND_ASSET_DIGESTS).length
  if (staleAsset || Object.keys(brandDigests).length !== expectedAssetCount) {
    throw new Error(
      `Match the reviewed brand asset digest: ${staleAsset ?? 'inventory'}.`,
    )
  }
}

/**
 * Verify that an ordinary AppImage launch keeps the Chromium sandbox enabled.
 *
 * @param {object} builder - The parsed electron-builder configuration.
 * @throws {Error} On a legacy toolset or any sandbox-disabling launcher
 *   argument.
 */
export function validateAppImageLaunchSafety(builder) {
  if (builder.toolsets?.appimage !== RELEASE_CONTRACT.appImageToolset) {
    throw new Error(
      `Build the AppImage with toolset ${RELEASE_CONTRACT.appImageToolset}; the legacy toolset writes --no-sandbox into the desktop entry.`,
    )
  }
  const executableArgs = builder.appImage?.executableArgs
  if (!Array.isArray(executableArgs) || executableArgs.length > 0) {
    throw new Error('Declare an explicitly empty AppImage executableArgs list.')
  }
  const sandboxArgs = [
    ...(builder.linux?.executableArgs ?? []),
    ...(builder.deb?.executableArgs ?? []),
  ]
  if (sandboxArgs.includes('--no-sandbox')) {
    throw new Error('Keep the Chromium sandbox enabled in every launcher.')
  }
}

/**
 * Verify the release version and repository metadata for consistency.
 *
 * @returns {Promise<string>} The verified application version.
 * @throws {Error} On inconsistent or unsafe release metadata.
 */
export async function checkMetadata() {
  const packageJson = JSON.parse(await text('package.json'))
  const lock = JSON.parse(await text('package-lock.json'))
  const builder = await text('electron-builder.yml')
  const builderConfiguration = loadYaml(builder)
  const buildSidecar = await text('scripts/build-sidecar.sh')
  const sidecarSpec = await text('sidecar/supraspina-sidecar.spec')
  const smokeAppImage = await text('scripts/smoke-appimage.sh')
  const smokeDebian = await text('scripts/smoke-installed-deb.sh')
  const about = await text('src/renderer/screens/AboutCard.tsx')
  const readme = await text('README.md')

  // The private flag only blocks npm publication; the repository is public.
  if (packageJson.private !== true) {
    throw new Error('Keep package.json private so npm never publishes the app.')
  }

  const version = validateVersionAgreement(await readVersionFields())
  // Cross-check the line-level read against the parsed manifests.
  if (
    packageJson.version !== version ||
    lock.version !== version ||
    lock.packages?.['']?.version !== version ||
    builderConfiguration.releaseInfo?.releaseDate !== appVersionDate(version)
  ) {
    throw new Error(
      'Match the parsed package, lock, and builder metadata to the stamped version.',
    )
  }
  if (
    !/^artifactName: \$\{name\}-\$\{version\}-\$\{arch\}\.\$\{ext\}$/m.test(
      builder,
    )
  ) {
    throw new Error(
      'Match electron-builder artifactName to the release contract.',
    )
  }
  if (
    JSON.stringify(builderConfiguration.deb?.depends) !==
    JSON.stringify(REQUIRED_DEB_DEPENDENCIES)
  ) {
    throw new Error(
      'Install exactly the reviewed Ubuntu runtime dependencies through the Debian package.',
    )
  }
  validatePackagingContract({
    buildSidecar,
    sidecarSpec,
    smokeAppImage,
    smokeDebian,
  })
  validateReleaseMetadataPackaging(builderConfiguration)
  validatePackagingLayout(builderConfiguration)
  validateLinuxOnlyRelease({
    packageJson,
    builder: builderConfiguration,
    pythonToolchain: JSON.parse(
      await text('sidecar/requirements/release-toolchain.json'),
    ),
    requirementNames: await entryNames('sidecar/requirements'),
    scriptNames: await entryNames('scripts'),
    version,
  })
  validateProductIdentity({
    packageJson,
    builder: builderConfiguration,
    brandDigests: Object.fromEntries(
      await Promise.all(
        Object.keys(BRAND_ASSET_DIGESTS).map(async (name) => [
          name,
          await digest(name),
        ]),
      ),
    ),
  })
  validateAppImageLaunchSafety(builderConfiguration)
  if (
    !about.includes("version as APP_VERSION } from '../../../package.json'") ||
    !about.includes('describeProductVersion(APP_VERSION, APP_BUILD_IDENTITY)')
  ) {
    throw new Error(
      'Source the in-app version from package.json and the embedded build identity.',
    )
  }
  if (
    !readme.includes('actions/workflows/quality-gates.yml') ||
    readme.includes('actions/workflows/package.yml')
  ) {
    throw new Error('Point the README.md CI badge to quality-gates.yml.')
  }
  return version
}

function normalizeOrigin(url) {
  const withoutCredentials = url.replace(
    /^https:\/\/[^/@]+@github\.com\//,
    'https://github.com/',
  )
  if (withoutCredentials.startsWith('git@github.com:')) {
    return withoutCredentials
      .slice('git@github.com:'.length)
      .replace(/\.git$/, '')
  }
  try {
    const parsed = new URL(withoutCredentials)
    if (parsed.hostname !== 'github.com') return ''
    return parsed.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/, '')
  } catch {
    return ''
  }
}

function defaultGitState() {
  return {
    head: captureGit('rev-parse', 'HEAD'),
    originMain: captureGit('rev-parse', 'refs/remotes/origin/main'),
    originUrl: captureGit('remote', 'get-url', 'origin'),
    tagType: (tag) => captureGit('cat-file', '-t', `refs/tags/${tag}`),
    tagObject: (tag) => captureGit('rev-parse', `refs/tags/${tag}`),
    tagTarget: (tag) => captureGit('rev-parse', `refs/tags/${tag}^{}`),
    tagMessage: (tag) =>
      captureGit(
        'for-each-ref',
        '--format=%(contents:subject)',
        `refs/tags/${tag}`,
      ),
    tags: captureGit('tag', '--list', 'v*').split('\n').filter(Boolean),
    isAncestor: gitIsAncestor,
    changedPaths: [
      ...captureGitNul('diff', '--name-only', '-z', 'HEAD'),
      ...captureGitNul('diff', '--cached', '--name-only', '-z', 'HEAD'),
      ...captureGitNul('ls-files', '--others', '--exclude-standard', '-z'),
    ],
  }
}

function defaultAuthenticatedRefs(repository, tag, previousTag, env) {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN
  if (!token) {
    throw new Error(
      'Provide GH_TOKEN to authenticate refs during strict release validation.',
    )
  }
  const commandEnv = { ...process.env, GH_TOKEN: token }
  const query = (endpoint) =>
    JSON.parse(
      capture(
        'gh',
        ['api', endpoint, '--jq', '{sha:.object.sha,type:.object.type}'],
        {
          env: commandEnv,
        },
      ),
    )
  const refs = {
    main: query(`/repos/${repository}/git/ref/heads/main`),
    tag: query(`/repos/${repository}/git/ref/tags/${tag}`),
  }
  if (previousTag) {
    refs.previousTag = query(`/repos/${repository}/git/ref/tags/${previousTag}`)
  }
  return refs
}

function isInsideArtifacts(path, artifactsDirectory) {
  if (!artifactsDirectory) return false
  const absolute = resolve(new URL('../', import.meta.url).pathname, path)
  const rel = relative(artifactsDirectory, absolute)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')
}

/**
 * Validate the exact tag, repository, authenticated refs, and clean source tree.
 *
 * Inject `gitState` and `authenticatedRefs` so every refusal has a
 * deterministic unit test without touching the caller's Git checkout.
 *
 * @param {object} options
 * @param {string} options.version
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.gitState]
 * @param {object} options.authenticatedRefs - The authenticated remote refs.
 * @param {string | null} [options.artifactsDirectory]
 * @throws {Error} On an unauthorized repository, ref, tag, commit, or worktree.
 */
export function validateStrictRelease({
  version,
  env = process.env,
  gitState = defaultGitState(),
  authenticatedRefs,
  artifactsDirectory = null,
}) {
  requireAppVersion(version)
  const tag = `v${version}`
  const expectedRef = `refs/tags/${tag}`
  const authority = releaseAuthority(env)
  if (env.GITHUB_REPOSITORY !== authority) {
    throw new Error(
      `Use the expected repository: ${authority}, found ${env.GITHUB_REPOSITORY || 'none'}.`,
    )
  }
  if (
    env.GITHUB_REF_TYPE !== 'tag' ||
    env.GITHUB_REF_NAME !== tag ||
    env.GITHUB_REF !== expectedRef
  ) {
    throw new Error(`Use the expected workflow ref: ${expectedRef}.`)
  }
  if (env.GITHUB_SHA !== gitState.head) {
    throw new Error('Match the workflow SHA to HEAD.')
  }
  if (normalizeOrigin(gitState.originUrl) !== authority) {
    throw new Error('Point origin to the expected GitHub repository.')
  }
  if (gitState.tagType(tag) !== 'tag') {
    throw new Error(`Use ${tag} as an annotated tag.`)
  }
  if (gitState.tagMessage(tag).trim() !== `Supraspina ${version}`) {
    throw new Error(`Use the annotated tag message: Supraspina ${version}.`)
  }
  if (gitState.tagTarget(tag) !== gitState.head) {
    throw new Error(`Point ${tag} to HEAD.`)
  }
  if (gitState.originMain !== gitState.head) {
    throw new Error('Match origin/main to the tagged workflow HEAD.')
  }

  // Order releases by the instant their tags name. Tags in any other form are
  // not releases of this scheme and take no part in the ordering.
  const releaseTags = gitState.tags.filter(
    (candidate) =>
      candidate.startsWith('v') && parseAppVersion(candidate.slice(1)) !== null,
  )
  if (!releaseTags.includes(tag)) {
    throw new Error(`Fetch the current release tag: ${tag}.`)
  }
  const previousTag = releaseTags
    .filter((candidate) => candidate !== tag)
    .sort((left, right) => compareAppVersions(right.slice(1), left.slice(1)))[0]

  if (previousTag) {
    const previousVersion = previousTag.slice(1)
    if (compareAppVersions(version, previousVersion) <= 0) {
      throw new Error(
        `Stamp a version later than ${previousVersion}; found ${version}.`,
      )
    }
    if (gitState.tagType(previousTag) !== 'tag') {
      throw new Error(`Keep the prior release ${previousTag} annotated.`)
    }
    const previousTarget = gitState.tagTarget(previousTag)
    if (!gitState.isAncestor(previousTarget, gitState.head)) {
      throw new Error(
        `Keep the prior release ${previousTag} in the tagged commit history.`,
      )
    }
  }

  const remote =
    authenticatedRefs ??
    defaultAuthenticatedRefs(authority, tag, previousTag, env)
  if (remote.main?.type !== 'commit' || remote.main?.sha !== gitState.head) {
    throw new Error('Match authenticated origin/main to the workflow HEAD.')
  }
  if (
    remote.tag?.type !== 'tag' ||
    remote.tag?.sha !== gitState.tagObject(tag)
  ) {
    throw new Error('Match the authenticated tag ref to the local tag object.')
  }
  if (
    previousTag &&
    (remote.previousTag?.type !== 'tag' ||
      remote.previousTag?.sha !== gitState.tagObject(previousTag))
  ) {
    throw new Error(
      'Match the authenticated prior release tag to the local tag object.',
    )
  }

  const dirty = [...new Set(gitState.changedPaths)].filter(
    (path) => !isInsideArtifacts(path, artifactsDirectory),
  )
  if (dirty.length > 0) {
    throw new Error(`Clean the release worktree: ${dirty.sort().join(', ')}.`)
  }
}

/**
 * Run the requested metadata or strict release verification.
 *
 * @param {object} options
 * @param {'metadata' | 'strict'} options.mode
 * @param {string | null | undefined} options.artifacts - The artifact
 *   directory, if any.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object | undefined} options.gitState
 * @param {object | undefined} options.authenticatedRefs
 * @returns {Promise<string>} The verified application version.
 * @throws {Error} On invalid modes, metadata, refs, or artifacts.
 */
export async function runReleaseCheck({
  mode,
  artifacts,
  env = process.env,
  gitState,
  authenticatedRefs,
}) {
  if (!['metadata', 'strict'].includes(mode)) {
    throw new Error('Set --mode to metadata or strict.')
  }
  const version = await checkMetadata()
  const artifactsDirectory = artifacts ? resolve(artifacts) : null
  if (mode === 'strict') {
    validateStrictRelease({
      version,
      env,
      gitState,
      authenticatedRefs,
      artifactsDirectory,
    })
  }
  if (artifactsDirectory) {
    await verifyChecksums(artifactsDirectory, version)
  }
  return version
}

/**
 * Format the successful release-consistency message.
 *
 * @param {'metadata' | 'strict'} mode
 * @param {string} version
 * @returns {string}
 */
export function formatReleaseConsistencySuccess(mode, version) {
  return `Verified release consistency in ${mode} mode for ${version}.`
}

/**
 * Format a failed release-consistency check as one actionable line.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function formatReleaseConsistencyFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return `check-release: ${message.trim() || 'The release-consistency check failed.'}`
}

/**
 * Run the release-consistency gate as a command-line entry point.
 *
 * @param {{argv?: string[], stdout?: {write: Function}, stderr?: {write:
 *   Function}}} [io]
 * @returns {Promise<number>} The exit code: 0 on success and 1 on a failed
 *   check.
 */
export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const modeIndex = argv.indexOf('--mode')
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : 'metadata'
  const artifactsIndex = argv.indexOf('--artifacts')
  const artifacts = artifactsIndex >= 0 ? argv[artifactsIndex + 1] : null
  try {
    const version = await runReleaseCheck({ mode, artifacts })
    stdout.write(`${formatReleaseConsistencySuccess(mode, version)}\n`)
    return 0
  } catch (error) {
    stderr.write(`${formatReleaseConsistencyFailure(error)}\n`)
    return 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main()
}
