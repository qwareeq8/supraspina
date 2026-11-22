#!/usr/bin/env node
/** Validates the exact, hash-locked Python 3.12.10 Linux release inputs. */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(new URL('../', import.meta.url).pathname)
const requirements = join(root, 'sidecar', 'requirements')

function normalizeName(name) {
  return name.toLowerCase().replaceAll(/[_.-]+/g, '-')
}

function logicalRequirements(text) {
  const logical = []
  let current = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    current += `${current ? ' ' : ''}${line.replace(/\\$/, '').trim()}`
    if (!line.endsWith('\\')) {
      logical.push(current)
      current = ''
    }
  }
  if (current) throw new Error('Terminate the final lockfile continuation.')
  return logical
}

/**
 * Parse one hashed requirements lock into normalized package pins.
 *
 * @param {string} text
 * @param {string} label - The lockfile label for diagnostics.
 * @returns {Map<string, {version: string, hashes: string[]}>} The normalized
 *   pins and hashes.
 * @throws {Error} On malformed, duplicate, or unhashed requirements.
 */
export function parseHashedLock(text, label) {
  const result = new Map()
  for (const line of logicalRequirements(text)) {
    const match = line.match(
      /^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)(?:\s*;\s*[^\\]+)?\s+(.*)$/,
    )
    if (!match) {
      throw new Error(`Provide an exact requirement pin in ${label}: ${line}.`)
    }
    const [, rawName, version, suffix] = match
    const hashes = [...suffix.matchAll(/--hash=sha256:([a-f0-9]{64})/g)].map(
      (entry) => entry[1],
    )
    if (hashes.length === 0) {
      throw new Error(
        `Add a SHA-256 hash to ${label} for ${rawName}==${version}.`,
      )
    }
    if (suffix.replaceAll(/--hash=sha256:[a-f0-9]{64}/g, '').trim()) {
      throw new Error(`Use supported lock syntax in ${label} for ${rawName}.`)
    }
    const name = normalizeName(rawName)
    if (result.has(name))
      throw new Error(`Remove duplicate package ${name} from ${label}.`)
    result.set(name, { version, hashes })
  }
  if (result.size === 0)
    throw new Error(`Add packages to the empty ${label} lock.`)
  return result
}

function parseInput(text, label) {
  const result = new Map()
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/#.*/, '').trim()
    if (!cleaned) continue
    const match = cleaned.match(/^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)$/)
    if (!match)
      throw new Error(`Provide an exact input in ${label}: ${cleaned}.`)
    result.set(normalizeName(match[1]), match[2])
  }
  return result
}

function requirePins(lock, pins, label) {
  for (const [name, version] of pins) {
    const actual = lock.get(name)?.version
    if (actual !== version) {
      throw new Error(
        `Pin ${name}==${version} in ${label}; found ${actual ?? 'missing'}.`,
      )
    }
  }
}

/**
 * Verify the pinned Python runtime and release lockfiles.
 *
 * @returns {Promise<{python: string, linuxPackages: number, qualityPackages: number, toolchainPackages: number}>}
 * @throws {Error} On stale toolchain metadata or inconsistent lockfiles.
 */
export async function checkPythonReleaseLocks() {
  const toolchain = JSON.parse(
    await readFile(join(requirements, 'release-toolchain.json'), 'utf8'),
  )
  if (
    toolchain.schemaVersion !== 1 ||
    toolchain.python !== '3.12.10' ||
    toolchain.pip !== '26.2.1'
  ) {
    throw new Error('Use the expected runtime pin in release-toolchain.json.')
  }

  const runtimePins = parseInput(
    await readFile(join(requirements, 'release.in'), 'utf8'),
    'release.in',
  )
  const qualityPins = parseInput(
    await readFile(join(requirements, 'quality.in'), 'utf8'),
    'quality.in',
  )
  const toolchainPins = parseInput(
    await readFile(join(requirements, 'toolchain.in'), 'utf8'),
    'toolchain.in',
  )
  for (const [name, version] of [
    ['pip', toolchain.pip],
    ['build', toolchain.build],
    ['hatchling', toolchain.hatchling],
    ['setuptools', toolchain.setuptools],
    ['wheel', toolchain.wheel],
  ]) {
    if (toolchainPins.get(name) !== version) {
      throw new Error(`Match the toolchain input for ${name}.`)
    }
  }

  const targetNames = Object.keys(toolchain.targets ?? {})
  if (
    targetNames.length !== 1 ||
    targetNames[0] !== 'linux-x86_64' ||
    toolchain.targets['linux-x86_64'] !== 'release-linux-x86_64.txt'
  ) {
    throw new Error(
      'Declare exactly the linux-x86_64 release target in release-toolchain.json.',
    )
  }
  const linux = parseHashedLock(
    await readFile(
      join(requirements, toolchain.targets['linux-x86_64']),
      'utf8',
    ),
    'linux release lock',
  )
  const quality = parseHashedLock(
    await readFile(join(requirements, 'quality-linux-x86_64.txt'), 'utf8'),
    'quality lock',
  )
  const tools = parseHashedLock(
    await readFile(join(requirements, 'toolchain.txt'), 'utf8'),
    'toolchain lock',
  )

  requirePins(linux, runtimePins, 'linux release lock')
  requirePins(quality, qualityPins, 'quality lock')
  requirePins(tools, toolchainPins, 'toolchain lock')
  if (linux.has('macholib')) {
    throw new Error('Remove the macOS macholib closure from the Linux lock.')
  }
  for (const devName of qualityPins.keys()) {
    if (linux.has(devName)) {
      throw new Error(
        `Remove the quality-only package from the release lock: ${devName}.`,
      )
    }
  }
  return {
    python: toolchain.python,
    linuxPackages: linux.size,
    qualityPackages: quality.size,
    toolchainPackages: tools.size,
  }
}

async function main() {
  const result = await checkPythonReleaseLocks()
  console.log(
    `Verified Python release locks for Python ${result.python}: ` +
      `${result.linuxPackages} Linux, ${result.qualityPackages} quality, and ` +
      `${result.toolchainPackages} toolchain packages.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
