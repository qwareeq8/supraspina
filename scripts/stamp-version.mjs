/**
 * Stamps one UTC date-time version into every file that must agree on it.
 *
 * `npm run version:stamp` sets the version from the current UTC minute.
 * `scripts/check-release.mjs` reads the same field table, so the stamped set
 * and the checked set cannot drift apart.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  appVersionDate,
  appVersionFromDate,
  formatAppVersion,
} from './app-version.mjs'

const root = new URL('../', import.meta.url)

/**
 * Every stamped field. `kind` names what the field holds: the machine-form
 * version or the UTC release date that the version names. Each pattern
 * captures the text before the value, the value, and the text after it, and
 * must match exactly once.
 */
export const VERSION_FIELDS = Object.freeze([
  {
    path: 'package.json',
    kind: 'version',
    pattern: /^( {2}"version": ")([^"]*)(",)$/m,
  },
  {
    path: 'package-lock.json',
    kind: 'version',
    pattern: /^( {2}"version": ")([^"]*)(",)$/m,
  },
  {
    path: 'package-lock.json',
    kind: 'version',
    pattern:
      /^( {4}"": \{\n {6}"name": "supraspina",\n {6}"version": ")([^"]*)(",)$/m,
  },
  {
    path: 'CITATION.cff',
    kind: 'version',
    pattern: /^(version: ')([^']*)(')$/m,
  },
  {
    path: 'CITATION.cff',
    kind: 'date',
    pattern: /^(date-released: ')([^']*)(')$/m,
  },
  {
    path: 'electron-builder.yml',
    kind: 'date',
    pattern: /^(releaseInfo:\n {2}releaseDate: ')([^']*)(')$/m,
  },
  {
    path: 'sidecar/pyproject.toml',
    kind: 'version',
    pattern:
      /^(\[project\]\nname = "supraspina-sidecar"\nversion = ")([^"]*)(")$/m,
  },
  {
    path: 'sidecar/supraspina_sidecar/__init__.py',
    kind: 'version',
    pattern: /^(__version__ = ")([^"]*)(")$/m,
  },
  {
    path: 'sidecar/uv.lock',
    kind: 'version',
    pattern: /^(name = "supraspina-sidecar"\nversion = ")([^"]*)(")$/m,
  },
])

function globalPattern(field) {
  return new RegExp(field.pattern.source, `${field.pattern.flags}g`)
}

function describeField(field) {
  return `the ${field.kind === 'date' ? 'release date' : 'version'} in ${field.path}`
}

/**
 * Read the value of one stamped field from its file text.
 *
 * @param {string} source
 * @param {object} field - One {@link VERSION_FIELDS} entry.
 * @returns {string}
 * @throws {Error} On a field that is missing or present more than once.
 */
export function readVersionField(source, field) {
  const matches = [...source.matchAll(globalPattern(field))]
  if (matches.length !== 1) {
    throw new Error(`Write ${describeField(field)} exactly once.`)
  }
  return matches[0][2]
}

/**
 * Return the file text with one field set to the value its kind requires.
 *
 * @param {string} source
 * @param {object} field - One {@link VERSION_FIELDS} entry.
 * @param {string} version
 * @returns {string}
 */
export function writeVersionField(source, field, version) {
  readVersionField(source, field)
  const value = field.kind === 'date' ? appVersionDate(version) : version
  return source.replace(
    field.pattern,
    (_match, before, _old, after) => `${before}${value}${after}`,
  )
}

/**
 * Read every stamped field of a checkout.
 *
 * @param {URL} [repository] - The repository root URL.
 * @returns {Promise<Array<{path: string, kind: string, value: string}>>}
 */
export async function readVersionFields(repository = root) {
  const sources = new Map()
  const values = []
  for (const field of VERSION_FIELDS) {
    if (!sources.has(field.path)) {
      sources.set(
        field.path,
        await readFile(new URL(field.path, repository), 'utf8'),
      )
    }
    values.push({
      path: field.path,
      kind: field.kind,
      value: readVersionField(sources.get(field.path), field),
    })
  }
  return values
}

/**
 * Stamp one version into every field of a checkout.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {URL} [options.repository] - The repository root URL.
 * @returns {Promise<string>} The stamped machine-form version.
 */
export async function stampVersion({
  now = new Date(),
  repository = root,
} = {}) {
  const version = appVersionFromDate(now)
  const paths = [...new Set(VERSION_FIELDS.map((field) => field.path))]
  // Stamp every file in memory first, so a malformed file changes nothing.
  const stamped = await Promise.all(
    paths.map(async (path) => {
      let source = await readFile(new URL(path, repository), 'utf8')
      for (const field of VERSION_FIELDS.filter((f) => f.path === path)) {
        source = writeVersionField(source, field, version)
      }
      return [path, source]
    }),
  )
  for (const [path, source] of stamped) {
    await writeFile(new URL(path, repository), source)
  }
  return version
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const version = await stampVersion()
  console.log(`Stamped version ${version} (${formatAppVersion(version)}).`)
}
