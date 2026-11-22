#!/usr/bin/env node
/** Stages only redistribution-approved scientific resources for PyInstaller. */

import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(new URL('../', import.meta.url).pathname)

function parseOutput(argv) {
  const index = argv.indexOf('--output')
  if (index < 0 || !argv[index + 1]) {
    throw new Error('Use stage-sidecar-resources.mjs --output <empty-dir>.')
  }
  return resolve(argv[index + 1])
}

async function assertRegular(path, label) {
  const info = await lstat(path)
  if (!info.isFile())
    throw new Error(`Provide ${label} as a regular file: ${path}.`)
}

/**
 * Stage only redistribution-approved resources into an empty directory.
 *
 * @param {string} output - An empty staging directory.
 * @returns {Promise<{staged: number, excluded: number, firstPartyHelpers: number}>}
 * @throws {Error} On unsafe destinations, malformed provenance, or invalid
 *   resources.
 */
export async function stageSidecarResources(output) {
  const outputInfo = await lstat(output)
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new Error(
      `Provide the staging output as a real directory: ${output}.`,
    )
  }
  if ((await readdir(output)).length !== 0) {
    throw new Error(`Empty the staging output: ${output}.`)
  }

  const provenancePath = join(root, 'THIRD_PARTY_PROVENANCE.json')
  await assertRegular(provenancePath, 'provenance inventory')
  const inventory = JSON.parse(await readFile(provenancePath, 'utf8'))
  if (
    inventory.schemaVersion !== 1 ||
    !inventory.resourceFiles ||
    typeof inventory.resourceFiles !== 'object'
  ) {
    throw new Error('Provide a valid provenance inventory shape.')
  }

  let staged = 0
  let excluded = 0
  for (const [relative, record] of Object.entries(inventory.resourceFiles).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (
      !relative.startsWith('resources/') ||
      relative.includes('\\') ||
      relative.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`Use a safe provenance path: ${relative}.`)
    }
    // The sidecar acquires every other delivery from the pinned archive.
    if (record.delivery !== 'bundled') {
      excluded += 1
      continue
    }
    const source = join(root, relative)
    await assertRegular(source, 'scientific resource')
    const sourceValue = await readFile(source)
    const sourceSha256 = createHash('sha256').update(sourceValue).digest('hex')
    if (
      !/^[0-9a-f]{64}$/.test(record.sha256) ||
      record.sha256 !== sourceSha256
    ) {
      throw new Error(
        `Match the reviewed scientific resource digest: ${relative}.`,
      )
    }
    const destination = join(output, relative)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await copyFile(source, destination)
    staged += 1
  }

  const metadataDirectory = join(output, 'metadata')
  await mkdir(metadataDirectory, { recursive: true, mode: 0o700 })
  await copyFile(
    provenancePath,
    join(metadataDirectory, 'THIRD_PARTY_PROVENANCE.json'),
  )
  const scientificPinsPath = join(root, 'SCIENTIFIC_RESOURCE_PINS.json')
  await assertRegular(scientificPinsPath, 'scientific resource pin manifest')
  await copyFile(
    scientificPinsPath,
    join(metadataDirectory, 'SCIENTIFIC_RESOURCE_PINS.json'),
  )

  const helperSource = join(
    root,
    'sidecar',
    'supraspina_sidecar',
    'brainfov.py',
  )
  await assertRegular(helperSource, 'brain-FOV helper')
  const helperDestination = join(
    output,
    'resources',
    'brainfov',
    'brainfov_helper.py',
  )
  await mkdir(dirname(helperDestination), { recursive: true, mode: 0o700 })
  await copyFile(helperSource, helperDestination)

  return { staged, excluded, firstPartyHelpers: 1 }
}

async function main() {
  const result = await stageSidecarResources(parseOutput(process.argv.slice(2)))
  console.log(
    `Staged sidecar resources: ${result.staged} bundled, ${result.firstPartyHelpers} first-party helper, and ${result.excluded} excluded from distribution.`,
  )
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main()
}
