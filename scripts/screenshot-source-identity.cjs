/** Computes the build-source and browser identities for documentation captures. */

'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const MAX_SOURCE_FILES = 4096
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024
const SOURCE_DIRECTORIES = Object.freeze(['src'])
const SOURCE_FILES = Object.freeze([
  'electron.vite.config.ts',
  'package-lock.json',
  'package.json',
  'scripts/capture-documentation-screenshots.cjs',
  'scripts/screenshot-source-identity.cjs',
  'scripts/shot.cjs',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
])

function isProductionSource(relativePath) {
  return !/(?:^|\/)[^/]+(?:\.remediation)?\.test\.[cm]?[jt]sx?$/.test(
    relativePath,
  )
}

async function requireRegularFile(relativePath) {
  const absolutePath = path.join(ROOT, relativePath)
  const info = await fs.lstat(absolutePath)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size === 0 ||
    info.size > MAX_SOURCE_FILE_BYTES
  ) {
    throw new Error(
      `Keep the screenshot source as a bounded regular file: ${relativePath}.`,
    )
  }
  return fs.readFile(absolutePath)
}

async function walkSourceDirectory(relativeDirectory) {
  const absoluteDirectory = path.join(ROOT, relativeDirectory)
  const info = await fs.lstat(absoluteDirectory)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      `Keep the screenshot source as a regular directory: ${relativeDirectory}.`,
    )
  }
  const files = []
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    const relativePath = path.posix.join(relativeDirectory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Remove the screenshot-source symlink: ${relativePath}.`)
    }
    if (entry.isDirectory()) {
      files.push(...(await walkSourceDirectory(relativePath)))
    } else if (entry.isFile() && isProductionSource(relativePath)) {
      files.push(relativePath)
    } else if (!entry.isFile()) {
      throw new Error(
        `Keep only regular screenshot-source entries: ${relativePath}.`,
      )
    }
  }
  return files
}

/**
 * Compute the exact production source closure used by the screenshot build.
 *
 * @returns {Promise<{algorithm: string, fileCount: number, sha256: string}>}
 *   The stable path-and-content identity.
 */
async function documentationSourceIdentity() {
  const discovered = (
    await Promise.all(SOURCE_DIRECTORIES.map(walkSourceDirectory))
  ).flat()
  const files = [...new Set([...SOURCE_FILES, ...discovered])].sort()
  if (files.length === 0 || files.length > MAX_SOURCE_FILES) {
    throw new Error(
      `Keep the screenshot source closure within ${MAX_SOURCE_FILES} files.`,
    )
  }
  const digest = createHash('sha256')
  for (const relativePath of files) {
    const value = await requireRegularFile(relativePath)
    digest.update(relativePath, 'utf8')
    digest.update('\0')
    digest.update(String(value.length), 'ascii')
    digest.update('\0')
    digest.update(value)
    digest.update('\0')
  }
  return {
    algorithm: 'sha256-path-length-content-v1',
    fileCount: files.length,
    sha256: digest.digest('hex'),
  }
}

/**
 * Read the exact Playwright/Chromium contract used by the capture harness.
 *
 * @returns {Promise<object>} The stable package and browser identity.
 */
async function documentationRuntimeIdentity() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(
      'Capture documentation screenshots on the reviewed Linux x86_64 platform.',
    )
  }
  const [packageJson, browsers] = await Promise.all([
    requireRegularFile('package.json').then((value) =>
      JSON.parse(value.toString('utf8')),
    ),
    requireRegularFile('node_modules/playwright-core/browsers.json').then(
      (value) => JSON.parse(value.toString('utf8')),
    ),
  ])
  const chromium = browsers.browsers?.find(
    (browser) => browser.name === 'chromium',
  )
  const playwright = packageJson.devDependencies?.playwright
  if (
    !/^\d+\.\d+\.\d+$/.test(playwright ?? '') ||
    !/^\d+$/.test(chromium?.revision ?? '') ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(chromium?.browserVersion ?? '')
  ) {
    throw new Error('Restore the locked Playwright Chromium identity.')
  }
  return {
    engine: 'playwright-chromium',
    platform: 'linux-x86_64',
    playwright,
    chromiumRevision: chromium.revision,
    chromiumVersion: chromium.browserVersion,
  }
}

module.exports = {
  documentationRuntimeIdentity,
  documentationSourceIdentity,
}
