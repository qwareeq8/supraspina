#!/usr/bin/env node
/** Generates the sanitized Node/Electron distributable manifest and notices. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  BUNDLED_PACKAGES_FILE,
  parseBundledPackages,
} from './bundled-packages.mjs'
import {
  createReleasePackageManifest,
  releasePackageManifestName,
} from './release-package-manifest.mjs'

const root = resolve(new URL('../', import.meta.url).pathname)
const outputDirectory = join(
  root,
  'build',
  'release-metadata',
  'dependency-manifests',
)
const licenseName = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i
const maxLicenseBytes = 2 * 1024 * 1024
/** The renderer build's record of the npm packages Vite inlined. */
export const defaultBundledPackagesPath = join(
  root,
  'out',
  'renderer',
  BUNDLED_PACKAGES_FILE,
)

/**
 * Reviewed license texts of bundled packages whose npm tarball ships none,
 * keyed by `name@version` and pinned by SHA-256. NiiVue's LICENSE is taken
 * from the upstream tag of the same version (niivue/niivue,
 * `@niivue/niivue-v0.69.0`).
 */
export const reviewedLicenseTexts = Object.freeze({
  '@niivue/niivue@0.69.0': Object.freeze({
    name: 'LICENSE (upstream @niivue/niivue-v0.69.0)',
    sha256: '604be23eceeef93996165e2cd46eefd4d713f98f1b4a5414ab109516dc1b30bf',
    text: `BSD 2-Clause License

Copyright (c) 2021, Niivue
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`,
  }),
})
/** The exact files owned by the Node release-metadata stage. */
export const nodeReleaseMetadataNames = Object.freeze([
  'node-distributable.cyclonedx.json',
  'node-distributable.json',
  'node-third-party-notices.txt',
  releasePackageManifestName,
])
/** The reviewed Electron runtime version for every distributable. */
export const electronRuntimeVersion = '42.11.18'
/** The reviewed Electron and Chromium license-file contract. */
export const electronRuntimeLicenseContract = Object.freeze([
  Object.freeze({
    sourceName: 'LICENSE',
    name: 'LICENSE.electron.txt',
    bytes: 1_096,
    sha256: '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d',
  }),
  Object.freeze({
    sourceName: 'LICENSES.chromium.html',
    name: 'LICENSES.chromium.html',
    bytes: 20_008_860,
    sha256: 'ca0a3f71df977796bf39a99472783c1ce9378bf4d8f4142a95048c3843980415',
  }),
])

function runtimeLicenseRecords(contract = electronRuntimeLicenseContract) {
  return contract.map(({ name, bytes, sha256 }) => ({
    name,
    bytes,
    sha256,
  }))
}

function repositoryUrl(value) {
  if (typeof value === 'string') return value
  if (value && typeof value.url === 'string') return value.url
  return null
}

function productionPackageDirectories() {
  const output = execFileSync(
    'npm',
    ['ls', '--omit=dev', '--all', '--parseable'],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  return output
    .split(/\r?\n/)
    .filter((path) => path && resolve(path) !== root)
    .map((path) => resolve(path))
    .sort()
}

function reviewedLicense(packageJson) {
  const reviewed =
    reviewedLicenseTexts[`${packageJson.name}@${packageJson.version}`]
  if (!reviewed) return []
  const sha256 = createHash('sha256').update(reviewed.text).digest('hex')
  if (sha256 !== reviewed.sha256) {
    throw new Error(
      `Keep the reviewed license text of ${packageJson.name} at its pinned SHA-256.`,
    )
  }
  return [{ name: reviewed.name, sha256, text: reviewed.text }]
}

async function licenseFiles(directory) {
  const result = []
  for (const name of (await readdir(directory)).filter((entry) =>
    licenseName.test(entry),
  )) {
    const path = join(directory, name)
    const info = await lstat(path)
    if (!info.isFile() || info.size > maxLicenseBytes) {
      throw new Error(
        `Provide the dependency license as a bounded regular file: ${path}.`,
      )
    }
    const value = await readFile(path)
    result.push({
      name,
      sha256: createHash('sha256').update(value).digest('hex'),
      text: value.toString('utf8'),
    })
  }
  return result.sort((left, right) => left.name.localeCompare(right.name))
}

async function packageRecord(
  directory,
  lock,
  {
    production = false,
    embeddedRuntime = false,
    bundledInRenderer = false,
  } = {},
) {
  const packageJsonPath = join(directory, 'package.json')
  const info = await lstat(packageJsonPath)
  if (!info.isFile()) {
    throw new Error(
      `Provide dependency package.json as a regular file: ${packageJsonPath}.`,
    )
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  const lockPath = relative(root, directory).replaceAll('\\', '/')
  const lockRecord = lock.packages[lockPath]
  if (
    !lockRecord ||
    lockRecord.version !== packageJson.version ||
    lockRecord.license !== packageJson.license ||
    typeof lockRecord.integrity !== 'string'
  ) {
    throw new Error(
      `Match the installed dependency to package-lock: ${lockPath}.`,
    )
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    author:
      typeof packageJson.author === 'string'
        ? packageJson.author
        : (packageJson.author?.name ?? null),
    repository: repositoryUrl(packageJson.repository),
    integrity: lockRecord.integrity,
    lockPath,
    production,
    embeddedRuntime,
    bundledInRenderer,
    licenseFiles: await licenseFiles(directory).then((files) =>
      files.length > 0 ? files : reviewedLicense(packageJson),
    ),
  }
}

function notices(records) {
  const sections = [
    'Supraspina Node and Electron Distributable Notices',
    '================================================',
    '',
    'Generate these notices from package-lock.json and the exact installed package tree.',
    'Include Electron because its binary runtime ships in every installer,',
    'even though its npm package is a build-time dependency. Include the',
    'packages Vite inlines into the renderer bundle (recorded by the renderer',
    'build in out/renderer/bundled-packages.json) for the same reason.',
    '',
  ]
  for (const record of records) {
    sections.push(`${record.name} ${record.version}`)
    sections.push('-'.repeat(`${record.name} ${record.version}`.length))
    sections.push(`Declared license: ${record.license}`)
    if (record.bundledInRenderer) {
      sections.push('Bundled into the renderer by Vite.')
    }
    if (record.author) sections.push(`Author: ${record.author}`)
    if (record.repository) sections.push(`Repository: ${record.repository}`)
    if (record.licenseFiles.length === 0) {
      sections.push(
        'Retain the package metadata and author attribution here because the',
        'installed npm package declares the license above but contains no',
        'separate license file.',
      )
    }
    for (const license of record.licenseFiles) {
      sections.push('')
      sections.push(
        `${license.name} (SHA-256 ${license.sha256})`,
        license.text.trimEnd(),
      )
    }
    sections.push('', '')
  }
  return `${sections.join('\n').trimEnd()}\n`
}

function sha512Hex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+=*)$/.exec(integrity)
  if (!match)
    throw new Error(`Use one SHA-512 package integrity: ${integrity}.`)
  return Buffer.from(match[1], 'base64').toString('hex')
}

function cyclonedx(manifest) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: manifest.packageName,
        version: manifest.packageVersion,
        'bom-ref': `application:${manifest.packageName}@${manifest.packageVersion}`,
      },
      properties: [
        { name: 'supraspina:source-lock', value: manifest.sourceLock },
        {
          name: 'supraspina:embedded-electron',
          value: manifest.embeddedElectron,
        },
      ],
    },
    components: manifest.packages.map((record) => ({
      type: 'library',
      name: record.name,
      version: record.version,
      'bom-ref': `npm:${record.lockPath}@${record.version}`,
      scope: 'required',
      hashes: [{ alg: 'SHA-512', content: sha512Hex(record.integrity) }],
      licenses: [{ expression: record.license }],
      properties: [
        { name: 'supraspina:lock-path', value: record.lockPath },
        {
          name: 'supraspina:embedded-runtime',
          value: String(record.embeddedRuntime),
        },
        {
          name: 'supraspina:bundled-in-renderer',
          value: String(record.bundledInRenderer),
        },
      ],
    })),
  }
}

async function readBundledPackages(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'Build the renderer before generating Node release metadata; out/renderer/bundled-packages.json is missing.',
        { cause: error },
      )
    }
    throw error
  }
  return parseBundledPackages(JSON.parse(text))
}

async function assertEmptyDestination(destination) {
  try {
    const info = await lstat(destination)
    if (!info.isDirectory()) {
      throw new Error(
        'Provide the Node release-metadata destination as a real directory.',
      )
    }
    const entries = await readdir(destination)
    if (entries.length > 0) {
      throw new Error(
        `Start with an empty Node release-metadata destination; found: ${entries.sort().join(', ')}.`,
      )
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function assertExactDestination(destination) {
  const entries = (await readdir(destination)).sort()
  if (
    JSON.stringify(entries) !==
    JSON.stringify([...nodeReleaseMetadataNames].sort())
  ) {
    throw new Error('Write exactly the reviewed Node release-metadata files.')
  }
}

async function writeExclusive(path, value) {
  await writeFile(path, value, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  })
  await chmod(path, 0o644)
}

/**
 * Generate the bounded Node/Electron dependency manifest and notices.
 *
 * @param {string} [destination]
 * @param {object} [options] - Deterministic inputs for tests.
 * @param {object} [options.gitState]
 * @param {string} [options.bundledPackagesPath] - The renderer build's
 *   bundled-packages record.
 * @returns {Promise<object>} The generated distributable manifest.
 * @throws {Error} On inconsistent locks, packages, licenses, or Electron
 *   metadata.
 */
export async function generateNodeReleaseMetadata(
  destination = outputDirectory,
  { gitState, bundledPackagesPath = defaultBundledPackagesPath } = {},
) {
  await assertEmptyDestination(destination)
  const bundled = await readBundledPackages(bundledPackagesPath)
  const releasePackageManifest = await createReleasePackageManifest({
    gitState,
  })
  const lock = JSON.parse(
    await readFile(join(root, 'package-lock.json'), 'utf8'),
  )
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
    throw new Error('Provide a lockfileVersion 3 package-lock.json.')
  }
  const directories = productionPackageDirectories()
  const productionDirectories = new Set(directories)
  const electronDirectory = join(root, 'node_modules', 'electron')
  if (!directories.includes(electronDirectory))
    directories.push(electronDirectory)
  const bundledPaths = new Set(bundled.map((item) => item.lockPath))
  for (const item of bundled) {
    const directory = join(root, item.lockPath)
    const locked = lock.packages[item.lockPath]
    if (!locked || locked.version !== item.version) {
      throw new Error(
        `Match the bundled renderer package to package-lock: ${item.lockPath}.`,
      )
    }
    if (!directories.includes(directory)) directories.push(directory)
  }
  const records = await Promise.all(
    directories.sort().map((directory) =>
      packageRecord(directory, lock, {
        production: productionDirectories.has(directory),
        embeddedRuntime: directory === electronDirectory,
        bundledInRenderer: bundledPaths.has(
          relative(root, directory).replaceAll('\\', '/'),
        ),
      }),
    ),
  )
  records.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.version.localeCompare(right.version) ||
      left.lockPath.localeCompare(right.lockPath),
  )

  const rootDependencies = Object.keys(
    lock.packages[''].dependencies ?? {},
  ).sort()
  for (const dependency of rootDependencies) {
    if (!records.some((record) => record.name === dependency)) {
      throw new Error(
        `Add the production dependency to the manifest: ${dependency}.`,
      )
    }
  }
  const electron = records.filter((record) => record.embeddedRuntime)
  if (
    electron.length !== 1 ||
    electron[0].name !== 'electron' ||
    electron[0].version !== lock.packages[''].devDependencies.electron ||
    electron[0].version !== electronRuntimeVersion
  ) {
    throw new Error('Keep the embedded Electron runtime pin consistent.')
  }

  const manifest = {
    schemaVersion: 1,
    sourceLock: 'package-lock.json',
    packageName: lock.packages[''].name,
    packageVersion: lock.packages[''].version,
    productionRoots: rootDependencies,
    embeddedElectron: electron[0].version,
    electronRuntimeLicenses: runtimeLicenseRecords(),
    packages: records.map(({ licenseFiles: files, ...record }) => ({
      ...record,
      licenseFiles: files.map(({ text: _text, ...file }) => file),
    })),
  }
  await mkdir(destination, { recursive: true, mode: 0o700 })
  await assertEmptyDestination(destination)
  await writeExclusive(
    join(destination, 'node-distributable.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await writeExclusive(
    join(destination, 'node-distributable.cyclonedx.json'),
    `${JSON.stringify(cyclonedx(manifest), null, 2)}\n`,
  )
  await writeExclusive(
    join(destination, 'node-third-party-notices.txt'),
    notices(records),
  )
  await writeExclusive(
    join(destination, releasePackageManifestName),
    `${JSON.stringify(releasePackageManifest, null, 2)}\n`,
  )
  await assertExactDestination(destination)
  return manifest
}

async function main() {
  const manifest = await generateNodeReleaseMetadata()
  // Preserve the Electron and Chromium license files that electron-builder
  // already places at the packaged archive root. Do not restage or duplicate the
  // 20 MB Chromium inventory.
  console.log(
    `Generated Node distributable metadata for ${manifest.packages.length} packages and Electron ${manifest.embeddedElectron}.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
