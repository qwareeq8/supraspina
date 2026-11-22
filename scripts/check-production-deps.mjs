#!/usr/bin/env node
/** Verifies that the production updater dependency chain stays patched. */

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const MINIMUM_UPDATER = [6, 8, 9]
const MINIMUM_JS_YAML = [4, 3, 1]

/**
 * Parse one semantic version into numeric components.
 *
 * @param {string | undefined} value
 * @param {string} label - The dependency label for diagnostics.
 * @returns {number[]} The major, minor, and patch components.
 * @throws {Error} On malformed semantic versions.
 */
export function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value ?? '')
  if (!match) {
    throw new Error(`Provide a valid lockfile version for ${label}: ${value}.`)
  }
  return match.slice(1).map(Number)
}

/**
 * Compare one parsed version against an inclusive minimum.
 *
 * @param {number[]} actual
 * @param {number[]} minimum
 * @returns {boolean}
 */
export function isAtLeast(actual, minimum) {
  for (const [index, part] of actual.entries()) {
    if (part !== minimum[index]) return part > minimum[index]
  }
  return true
}

/**
 * Verify the production updater dependency chain against reviewed versions.
 *
 * @returns {Promise<{updaterVersion: string, yamlVersions: string[]}>}
 * @throws {Error} On missing, malformed, or unreviewed dependency versions.
 */
export async function checkProductionDependencies() {
  const lock = JSON.parse(
    await readFile(new URL('../package-lock.json', import.meta.url)),
  )
  const packages = lock.packages ?? {}
  const updaterVersion = packages['node_modules/electron-updater']?.version
  const updaterParts = parseVersion(updaterVersion, 'electron-updater')

  if (updaterParts[0] !== 6 || updaterParts[1] !== 8) {
    throw new Error(
      `Keep electron-updater in the reviewed 6.8.x line; found ${updaterVersion}.`,
    )
  }
  if (!isAtLeast(updaterParts, MINIMUM_UPDATER)) {
    throw new Error(
      `Use electron-updater 6.8.9 or newer; found ${updaterVersion}.`,
    )
  }

  const yamlEntries = Object.entries(packages).filter(([path]) =>
    path.endsWith('node_modules/js-yaml'),
  )
  if (yamlEntries.length === 0) {
    throw new Error('Include a js-yaml resolution in package-lock.json.')
  }
  for (const [path, entry] of yamlEntries) {
    const yamlVersion = entry.version
    if (!isAtLeast(parseVersion(yamlVersion, path), MINIMUM_JS_YAML)) {
      throw new Error(
        `Upgrade the vulnerable js-yaml resolution at ${path}: ${yamlVersion}.`,
      )
    }
  }

  const yamlVersions = [
    ...new Set(yamlEntries.map(([, entry]) => entry.version)),
  ]
  return { updaterVersion, yamlVersions }
}

/**
 * Format the successful production-dependency verification message.
 *
 * @param {{updaterVersion: string, yamlVersions: string[]}} versions
 * @returns {string}
 */
export function formatProductionDependencySuccess({
  updaterVersion,
  yamlVersions,
}) {
  return (
    `Verified production dependencies using electron-updater ${updaterVersion} ` +
    `and js-yaml ${yamlVersions.join(', ')}.`
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await checkProductionDependencies()
  console.log(formatProductionDependencySuccess(result))
}
