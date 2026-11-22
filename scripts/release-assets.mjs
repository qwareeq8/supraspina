#!/usr/bin/env node
/** Validates release assets and creates or verifies deterministic SHA-256 sums. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { load as loadYaml } from 'js-yaml'

import {
  ACCEPTANCE_FILE,
  coreReleaseAssetNames,
  verifyPublishedAcceptance,
} from './release-acceptance.mjs'

/** The deterministic checksum-manifest filename. */
export const CHECKSUM_FILE = 'SHA256SUMS'

/**
 * Build the exact release-asset filename set for one version.
 *
 * @param {string} version
 * @returns {string[]}
 */
export function expectedAssetNames(version) {
  return [...coreReleaseAssetNames(version), ACCEPTANCE_FILE]
}

/**
 * Verify that electron-builder's Linux channel points at this exact release.
 *
 * @param {string} directory
 * @param {string} version
 * @throws {Error} On missing, malformed, stale, or mismatched channel metadata.
 */
export async function assertLinuxChannelMetadata(directory, version) {
  const channel = await readFile(join(directory, 'latest-linux.yml'), 'utf8')
  const appImage = `supraspina-${version}-x86_64.AppImage`
  const debianPackage = `supraspina-${version}-amd64.deb`
  const metadata = loadYaml(channel)
  const expectedFiles = await Promise.all(
    [appImage, debianPackage].map(async (name) => {
      const path = join(directory, name)
      return {
        name,
        sha512: await hashFile(path, 'sha512', 'base64'),
        size: (await stat(path)).size,
      }
    }),
  )
  const expectedAppImage = expectedFiles[0]
  const validRecord =
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata)
  const record = validRecord ? metadata : {}
  const files = Array.isArray(record.files) ? record.files : []
  const filesByUrl = new Map(
    files
      .filter(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          typeof entry.url === 'string',
      )
      .map((entry) => [entry.url, entry]),
  )
  const validFiles =
    files.length === expectedFiles.length &&
    filesByUrl.size === expectedFiles.length &&
    expectedFiles.every(
      (expected) =>
        filesByUrl.get(expected.name)?.sha512 === expected.sha512 &&
        filesByUrl.get(expected.name)?.size === expected.size,
    )
  if (
    record.version !== version ||
    record.path !== appImage ||
    record.sha512 !== expectedAppImage.sha512 ||
    !validFiles
  ) {
    throw new Error(
      `Identify the expected asset in latest-linux.yml: ${version} and both Linux artifacts with exact size and SHA-512 integrity.`,
    )
  }
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm)
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', rejectHash)
    stream.on('end', resolveHash)
  })
  return hash.digest(encoding)
}

async function sha256(path) {
  return hashFile(path, 'sha256', 'hex')
}

/**
 * Verify the exact regular-file set in one release-asset directory.
 *
 * @param {string} directory
 * @param {string} version
 * @param {boolean} includeChecksums
 * @returns {Promise<string[]>} The sorted filenames.
 * @throws {Error} On missing, extra, or nonregular asset entries.
 */
export async function assertExactAssets(directory, version, includeChecksums) {
  const expected = expectedAssetNames(version)
  if (includeChecksums) expected.push(CHECKSUM_FILE)
  expected.sort()
  const entries = await readdir(directory, { withFileTypes: true })
  const nonRegular = entries
    .filter((entry) => !entry.isFile())
    .map((entry) => entry.name)
    .sort()
  if (nonRegular.length > 0) {
    throw new Error(
      `Remove non-regular release asset entries: ${nonRegular.join(', ')}.`,
    )
  }
  const actual = entries.map((entry) => entry.name).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Match the release assets; expected ${expected.join(', ')}; found ${actual.join(', ')}.`,
    )
  }
  return expected
}

/**
 * Create a deterministic checksum manifest for the exact release assets.
 *
 * @param {string} directory
 * @param {string} version
 * @returns {Promise<string[]>} The written checksum lines.
 * @throws {Error} On invalid assets, channel metadata, or an existing manifest.
 */
export async function createChecksums(directory, version) {
  const expected = await assertExactAssets(directory, version, false)
  await assertLinuxChannelMetadata(directory, version)
  await verifyPublishedAcceptance(directory, version)
  const lines = []
  for (const name of expected) {
    lines.push(`${await sha256(join(directory, name))}  ${name}`)
  }
  await writeFile(join(directory, CHECKSUM_FILE), `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return lines
}

/**
 * Verify a deterministic checksum manifest and every referenced release asset.
 *
 * @param {string} directory
 * @param {string} version
 * @returns {Promise<Array<{digest: string, name: string}>>}
 * @throws {Error} On invalid assets, channel metadata, lines, ordering, or
 *   digests.
 */
export async function verifyChecksums(directory, version) {
  const expected = await assertExactAssets(directory, version, true)
  await assertLinuxChannelMetadata(directory, version)
  await verifyPublishedAcceptance(directory, version)
  const expectedAssets = expected.filter((name) => name !== CHECKSUM_FILE)
  const content = await readFile(join(directory, CHECKSUM_FILE), 'utf8')
  const lines = content.trimEnd().split('\n')
  const names = new Set()
  const parsed = []
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([^/]+)$/.exec(line)
    if (!match) throw new Error(`Provide a valid SHA256SUMS line: ${line}.`)
    const [, digest, name] = match
    if (names.has(name))
      throw new Error(`Remove the duplicate checksum entry: ${name}.`)
    names.add(name)
    parsed.push({ digest, name })
  }
  const orderedNames = parsed.map(({ name }) => name)
  if (JSON.stringify(orderedNames) !== JSON.stringify(expectedAssets)) {
    throw new Error(
      'Include exactly the expected SHA256SUMS entries in sorted order.',
    )
  }
  for (const { digest, name } of parsed) {
    const actual = await sha256(join(directory, name))
    if (actual !== digest) throw new Error(`Match the checksum: ${name}.`)
  }
  return parsed
}

async function main() {
  const [command, directoryArg, version] = process.argv.slice(2)
  if (!['create', 'verify'].includes(command) || !directoryArg || !version) {
    throw new Error(
      'Use node scripts/release-assets.mjs <create|verify> <directory> <version>.',
    )
  }
  const directory = resolve(directoryArg)
  const result =
    command === 'create'
      ? await createChecksums(directory, version)
      : await verifyChecksums(directory, version)
  console.log(
    `Reviewed ${result.length} release assets in ${basename(directory)} after ` +
      `${command === 'create' ? 'creating' : 'verifying'} their checksums.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
