/**
 * Records which npm packages the renderer bundle contains, so that release
 * metadata can carry their licenses. Vite inlines renderer dependencies such
 * as React and NiiVue into `out/renderer`, although npm lists them as
 * development dependencies, which `npm ls --omit=dev` leaves out.
 *
 * The electron-vite config imports this module; its loader cannot parse a
 * shebang, so the module has none.
 */

import { readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))

/** The file the plugin writes next to the renderer entry. */
export const BUNDLED_PACKAGES_FILE = 'bundled-packages.json'
/** The schema of that file. */
export const BUNDLED_PACKAGES_SCHEMA = 'supraspina/renderer-bundled-packages'

/**
 * Give the package directory a bundled module lives in.
 *
 * @param {string} moduleId - A Rollup module ID.
 * @returns {string | null} The directory, or null for application code.
 */
export function packageDirectoryOf(moduleId) {
  const path = moduleId.replace(/^\0/, '').split('?')[0]
  const marker = `${sep}node_modules${sep}`
  const index = path.lastIndexOf(marker)
  if (index < 0) return null
  const rest = path.slice(index + marker.length).split(sep)
  const depth = rest[0]?.startsWith('@') ? 2 : 1
  if (rest.length <= depth || rest.slice(0, depth).some((part) => !part)) {
    return null
  }
  return path.slice(0, index + marker.length) + rest.slice(0, depth).join(sep)
}

/**
 * List the packages that contribute rendered code to a bundle.
 *
 * @param {Iterable<{ modules?: Record<string, { renderedLength: number }> }>} chunks - The Rollup output chunks.
 * @param {object} [options]
 * @param {string} [options.repository] - The root lock paths are relative to.
 * @param {(directory: string) => { name: string, version: string }} [options.readPackage]
 * @returns {{ name: string, version: string, lockPath: string }[]} The
 *   packages, sorted by lock path.
 */
export function bundledPackages(
  chunks,
  {
    repository = root,
    readPackage = (directory) =>
      JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')),
  } = {},
) {
  const directories = new Set()
  for (const chunk of chunks) {
    for (const [moduleId, info] of Object.entries(chunk.modules ?? {})) {
      if (!(info.renderedLength > 0)) continue
      const directory = packageDirectoryOf(moduleId)
      if (directory) directories.add(directory)
    }
  }
  const packages = new Map()
  for (const directory of directories) {
    const manifest = readPackage(directory)
    const lockPath = relative(repository, directory).split(sep).join('/')
    if (
      typeof manifest?.name !== 'string' ||
      typeof manifest.version !== 'string' ||
      !lockPath.startsWith('node_modules/')
    ) {
      throw new Error(`Name the bundled package at ${lockPath}.`)
    }
    packages.set(lockPath, {
      name: manifest.name,
      version: manifest.version,
      lockPath,
    })
  }
  return [...packages.values()].sort((a, b) =>
    a.lockPath.localeCompare(b.lockPath),
  )
}

/**
 * Build the Vite plugin that writes `bundled-packages.json` beside the
 * renderer entry.
 *
 * @param {object} [options]
 * @param {string} [options.repository] - The root lock paths are relative to.
 * @returns {import('vite').Plugin}
 */
export function bundledPackagesPlugin({ repository = root } = {}) {
  return {
    name: 'supraspina-bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(
        (item) => item.type === 'chunk',
      )
      const record = {
        schema: BUNDLED_PACKAGES_SCHEMA,
        schemaVersion: 1,
        packages: bundledPackages(chunks, { repository }),
      }
      this.emitFile({
        type: 'asset',
        fileName: BUNDLED_PACKAGES_FILE,
        source: `${JSON.stringify(record, null, 2)}\n`,
      })
    },
  }
}

/**
 * Validate a `bundled-packages.json` record.
 *
 * @param {unknown} value
 * @returns {{ name: string, version: string, lockPath: string }[]}
 * @throws {Error} On a record outside the schema.
 */
export function parseBundledPackages(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schema !== BUNDLED_PACKAGES_SCHEMA ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.packages)
  ) {
    throw new Error('Provide a valid renderer bundled-packages record.')
  }
  return value.packages.map((item) => {
    if (
      !item ||
      typeof item.name !== 'string' ||
      typeof item.version !== 'string' ||
      typeof item.lockPath !== 'string' ||
      !/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(
        item.lockPath,
      )
    ) {
      throw new Error('Provide a valid renderer bundled-packages entry.')
    }
    return { name: item.name, version: item.version, lockPath: item.lockPath }
  })
}
