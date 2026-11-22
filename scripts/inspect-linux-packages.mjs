#!/usr/bin/env node
/** Inspects the final Linux launcher metadata, icons, and sandbox policy. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  RELEASE_CONTRACT,
  REQUIRED_DEB_DEPENDENCIES,
} from './check-release.mjs'

const root = new URL('../', import.meta.url)
const NO_SANDBOX = '--no-sandbox'
/** The hicolor icon sizes required in the installed Debian package. */
export const REQUIRED_ICON_SIZES = Object.freeze([
  '16x16',
  '32x32',
  '48x48',
  '64x64',
  '128x128',
  '256x256',
  '512x512',
])

/**
 * Parse one freedesktop desktop entry into its `[Desktop Entry]` fields.
 *
 * @param {string} value
 * @returns {Record<string, string>}
 * @throws {Error} On a file without a `[Desktop Entry]` group.
 */
export function parseDesktopEntry(value) {
  const fields = {}
  let inEntry = false
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('[')) {
      inEntry = trimmed === '[Desktop Entry]'
      continue
    }
    if (!inEntry) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    fields[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim()
  }
  if (Object.keys(fields).length === 0) {
    throw new Error('Provide a desktop entry with a [Desktop Entry] group.')
  }
  return fields
}

function assertSharedLauncherFields(fields, label) {
  const expected = {
    Name: RELEASE_CONTRACT.productName,
    Type: 'Application',
    Icon: RELEASE_CONTRACT.packageName,
    StartupWMClass: RELEASE_CONTRACT.packageName,
    Terminal: 'false',
  }
  for (const [key, value] of Object.entries(expected)) {
    if (fields[key] !== value) {
      throw new Error(
        `Set ${key}=${value} in the ${label} desktop entry; found ${fields[key] ?? 'nothing'}.`,
      )
    }
  }
  if (!(fields.Categories ?? '').split(';').includes('Science')) {
    throw new Error(`List the Science category in the ${label} desktop entry.`)
  }
  if (Object.values(fields).some((value) => value.includes(NO_SANDBOX))) {
    throw new Error(
      `Remove ${NO_SANDBOX} from the ${label} desktop entry; an ordinary launch must keep the Chromium sandbox enabled.`,
    )
  }
}

/**
 * Verify that the AppImage desktop entry launches AppRun with the sandbox on.
 *
 * @param {Record<string, string>} fields - The parsed desktop-entry fields.
 * @param {string} version
 * @throws {Error} On a stale version or an unsafe generated launch path.
 */
export function assertAppImageLauncher(fields, version) {
  assertSharedLauncherFields(fields, 'AppImage')
  if (fields.Exec !== 'AppRun %U') {
    throw new Error(
      `Set Exec=AppRun %U in the AppImage desktop entry; found ${fields.Exec ?? 'nothing'}.`,
    )
  }
  if (fields['X-AppImage-Version'] !== version) {
    throw new Error(
      `Stamp X-AppImage-Version=${version}; found ${fields['X-AppImage-Version'] ?? 'nothing'}.`,
    )
  }
}

/**
 * Verify that the Debian desktop entry launches the installed executable safely.
 *
 * @param {Record<string, string>} fields - The parsed desktop-entry fields.
 * @throws {Error} On a wrong install prefix or a sandbox-disabling flag.
 */
export function assertDebianLauncher(fields) {
  assertSharedLauncherFields(fields, 'Debian')
  const expected = `/opt/${RELEASE_CONTRACT.productName}/${RELEASE_CONTRACT.packageName}`
  const exec = fields.Exec ?? ''
  if (exec !== `"${expected}" %U` && exec !== `${expected} %U`) {
    throw new Error(
      `Launch ${expected} with %U from the Debian desktop entry; found ${exec || 'nothing'}.`,
    )
  }
}

/**
 * Verify that the generated AppRun launcher never forces the sandbox off.
 *
 * @param {string} value - The AppRun script contents.
 * @throws {Error} On an unconditional sandbox-disabling launch.
 */
export function assertAppRunSandboxPolicy(value) {
  const lines = value.split(/\r?\n/).map((line) => line.trim())
  const assignments = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.startsWith('NO_SANDBOX='))
  if (assignments.length === 0 || assignments[0]?.line !== 'NO_SANDBOX=()') {
    throw new Error(
      'Start AppRun with an empty NO_SANDBOX array so an ordinary launch keeps the Chromium sandbox enabled.',
    )
  }
  // Allow the runtime's fail-safe only when the user-namespace probe guards it.
  for (const { line, index } of assignments.slice(1)) {
    if (!line.includes(NO_SANDBOX)) continue
    const guard = lines
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.startsWith('if ') || candidate === 'fi')
    if (
      guard !== undefined &&
      guard.startsWith('if ') &&
      /\bunshare\b/.test(guard)
    ) {
      continue
    }
    throw new Error(
      `Guard every ${NO_SANDBOX} assignment in AppRun behind the user-namespace probe.`,
    )
  }
  const unconditional = lines.some(
    (line) =>
      line.startsWith('exec ') &&
      line.includes(NO_SANDBOX) &&
      !line.includes('${NO_SANDBOX'),
  )
  if (unconditional) {
    throw new Error(
      `Remove the unconditional ${NO_SANDBOX} launch from AppRun.`,
    )
  }
}

/**
 * Verify the Debian control record against the reviewed product identity.
 *
 * @param {Record<string, string>} fields - The parsed control fields.
 * @param {string} version
 * @throws {Error} On stale identity, section, priority, or dependencies.
 */
export function assertDebianControl(fields, version) {
  const expected = {
    Package: RELEASE_CONTRACT.packageName,
    Version: version,
    Architecture: 'amd64',
    Maintainer: `${RELEASE_CONTRACT.author} <${RELEASE_CONTRACT.email}>`,
    Section: RELEASE_CONTRACT.debianSection,
    Priority: RELEASE_CONTRACT.debianPriority,
    Homepage: RELEASE_CONTRACT.homepage,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (fields[key] !== value) {
      throw new Error(
        `Set ${key}=${value} in the Debian control record; found ${fields[key] ?? 'nothing'}.`,
      )
    }
  }
  const descriptionSynopsis = (fields.Description ?? '').split('\n', 1)[0]
  if (descriptionSynopsis !== RELEASE_CONTRACT.linuxSynopsis) {
    throw new Error(
      `Set the first Debian Description line to ${RELEASE_CONTRACT.linuxSynopsis}; found ${descriptionSynopsis || 'nothing'}.`,
    )
  }
  const depends = (fields.Depends ?? '').split(',').map((entry) => entry.trim())
  if (JSON.stringify(depends) !== JSON.stringify(REQUIRED_DEB_DEPENDENCIES)) {
    throw new Error(
      `Depend on exactly the reviewed Debian runtimes: ${REQUIRED_DEB_DEPENDENCIES.join(', ')}.`,
    )
  }
}

function capture(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
}

function parseControlFields(value) {
  const fields = {}
  let current = null
  for (const line of value.split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      fields[current] += `\n${line.trim()}`
      continue
    }
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    current = line.slice(0, separator).trim()
    fields[current] = line.slice(separator + 1).trim()
  }
  return fields
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function inspectAppImage(appImagePath, version, expectedIconSha256) {
  const workspace = await mkdtemp(join(tmpdir(), 'supraspina-appimage-'))
  try {
    execFileSync(appImagePath, ['--appimage-extract'], {
      cwd: workspace,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const extracted = join(workspace, 'squashfs-root')
    const entries = await readdir(extracted)
    const desktopName = entries.find((name) => name.endsWith('.desktop'))
    if (desktopName !== `${RELEASE_CONTRACT.packageName}.desktop`) {
      throw new Error(
        `Name the embedded desktop entry ${RELEASE_CONTRACT.packageName}.desktop; found ${desktopName ?? 'nothing'}.`,
      )
    }
    const fields = parseDesktopEntry(
      await readFile(join(extracted, desktopName), 'utf8'),
    )
    assertAppImageLauncher(fields, version)
    assertAppRunSandboxPolicy(await readFile(join(extracted, 'AppRun'), 'utf8'))

    const iconName = `${RELEASE_CONTRACT.packageName}.png`
    if (!entries.includes(iconName)) {
      throw new Error(`Embed ${iconName} at the AppImage root.`)
    }
    const rootIcon = await sha256(join(extracted, iconName))
    if (rootIcon !== expectedIconSha256) {
      throw new Error('Embed the canonical mark as the AppImage root icon.')
    }
    const executable = await stat(join(extracted, RELEASE_CONTRACT.packageName))
    if (!executable.isFile() || (executable.mode & 0o111) === 0) {
      throw new Error('Ship an executable AppImage application binary.')
    }
    const sizes = await readdir(
      join(extracted, 'usr', 'share', 'icons', 'hicolor'),
    )
    const missing = REQUIRED_ICON_SIZES.filter((size) => !sizes.includes(size))
    if (missing.length > 0) {
      throw new Error(`Embed the hicolor icon sizes: ${missing.join(', ')}.`)
    }
    return { desktopName, exec: fields.Exec, iconSha256: rootIcon }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

async function inspectDebianPackage(debPath, version, expectedIconSha256) {
  // Read the control record with -f so every field starts at column zero and
  // only genuine RFC 822 continuations stay indented.
  const control = parseControlFields(capture('dpkg-deb', ['-f', debPath]))
  assertDebianControl(control, version)

  const workspace = await mkdtemp(join(tmpdir(), 'supraspina-deb-'))
  try {
    execFileSync('dpkg-deb', ['-x', debPath, workspace], { stdio: 'ignore' })
    const desktopPath = join(
      workspace,
      'usr',
      'share',
      'applications',
      `${RELEASE_CONTRACT.packageName}.desktop`,
    )
    const desktopInfo = await stat(desktopPath)
    if ((desktopInfo.mode & 0o777) !== 0o644) {
      throw new Error('Install the Debian desktop entry with mode 0644.')
    }
    assertDebianLauncher(parseDesktopEntry(await readFile(desktopPath, 'utf8')))

    const hicolor = join(workspace, 'usr', 'share', 'icons', 'hicolor')
    const digests = {}
    for (const size of REQUIRED_ICON_SIZES) {
      const iconPath = join(
        hicolor,
        size,
        'apps',
        `${RELEASE_CONTRACT.packageName}.png`,
      )
      const info = await stat(iconPath)
      if ((info.mode & 0o777) !== 0o644) {
        throw new Error(`Install the ${size} icon with mode 0644.`)
      }
      digests[size] = await sha256(iconPath)
    }
    if (digests['512x512'] !== expectedIconSha256) {
      throw new Error('Install the canonical mark as the 512x512 hicolor icon.')
    }
    const executable = await stat(
      join(
        workspace,
        'opt',
        RELEASE_CONTRACT.productName,
        RELEASE_CONTRACT.packageName,
      ),
    )
    if (!executable.isFile() || (executable.mode & 0o111) === 0) {
      throw new Error('Install an executable Debian application binary.')
    }
    return { control, iconDigests: digests }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || !value) {
      throw new Error(
        'Use inspect-linux-packages.mjs --appimage <path> --deb <path>.',
      )
    }
    values[flag.slice(2)] = resolve(value)
  }
  if (!values.appimage && !values.deb) {
    throw new Error(
      'Use inspect-linux-packages.mjs --appimage <path> and/or --deb <path>.',
    )
  }
  return values
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const version = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  ).version
  const expectedIconSha256 = await sha256(
    new URL('packaging/icon.png', root).pathname,
  )
  const reported = []
  if (options.appimage) {
    const appImage = await inspectAppImage(
      options.appimage,
      version,
      expectedIconSha256,
    )
    reported.push(`${basename(options.appimage)} with Exec=${appImage.exec}`)
  }
  if (options.deb) {
    const debian = await inspectDebianPackage(
      options.deb,
      version,
      expectedIconSha256,
    )
    reported.push(
      `${basename(options.deb)} as ${debian.control.Package} ` +
        `${debian.control.Version} (${debian.control.Section}/${debian.control.Priority})`,
    )
  }
  console.log(
    `Inspected ${reported.join(' and ')}; AppRun keeps the Chromium sandbox when unprivileged user namespaces work and conditionally opts out otherwise.`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
