#!/usr/bin/env node
/** Captures a deterministic synthetic documentation screenshot set. */

'use strict'

const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const prettier = require('prettier')

const {
  documentationRuntimeIdentity,
  documentationSourceIdentity,
} = require('./screenshot-source-identity.cjs')

const ROOT = path.resolve(__dirname, '..')
const OUTPUT_DIRECTORY = path.join(ROOT, 'docs', 'screenshots')
const CSS_WIDTH = 1600
const CSS_HEIGHT = 1000
const DEVICE_SCALE_FACTOR = 2
const MAX_PNG_BYTES = 64 * 1024 * 1024
const MAX_AUDIT_BYTES = 4 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MANIFEST_NAME = 'MANIFEST.json'
const README_NAME = 'README.md'

/** The command that reproduces the complete documentation screenshot set. */
const CAPTURE_COMMAND = 'npm run build && npm run screenshots:documentation'

/** Every approved documentation route and visual state. */
const DOCUMENTATION_ROUTES = Object.freeze(
  [
    { label: 'Dashboard', slug: 'dashboard', state: 'populated' },
    { label: 'Subjects', slug: 'subjects', state: 'populated' },
    { label: 'Runs', slug: 'runs', state: 'populated' },
    { label: 'Logs', slug: 'logs', state: 'populated' },
    { label: 'QC review', slug: 'qc-review', state: 'populated' },
    { label: 'Results', slug: 'results', state: 'populated' },
    { label: 'Analysis', slug: 'analysis', state: 'populated' },
    { label: 'Analysis', slug: 'analysis-grid', state: 'analysis-grid' },
    { label: 'Diagnostics', slug: 'diagnostics', state: 'populated' },
  ].map(Object.freeze),
)

const REQUIRED_CAPTURE_NAMES = Object.freeze([
  ...DOCUMENTATION_ROUTES.map(({ slug }) => `${slug}.png`),
  MANIFEST_NAME,
])

/**
 * Build the canonical screenshot-harness arguments for one route.
 *
 * @param {{label: string, slug: string, state: string}} route - One approved
 *   route.
 * @returns {string[]}
 * @throws {Error} On a route without string label, slug, and state fields.
 */
function captureArguments(route) {
  if (
    !route ||
    typeof route.label !== 'string' ||
    typeof route.slug !== 'string' ||
    typeof route.state !== 'string'
  ) {
    throw new Error('Provide a valid approved documentation route.')
  }
  return [
    'scripts/shot.cjs',
    route.label,
    route.slug,
    '--documentation',
    '--dark',
    '--density',
    'Cozy',
    '--reduced-motion',
    '--state',
    route.state,
    '--w',
    String(CSS_WIDTH),
    '--h',
    String(CSS_HEIGHT),
    '--dsf',
    String(DEVICE_SCALE_FACTOR),
    '--wait',
    '900',
  ]
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Provide an object for ${label}.`)
  }
  return value
}

/**
 * Create the deterministic synthetic screenshot manifest.
 *
 * @param {Record<string, object>} records - One verified record for every
 *   approved image.
 * @param {{runtime: object, source: object}} identity - The current build
 *   source and browser identities.
 * @returns {object} The schema-v3 documentation manifest.
 * @throws {Error} On an incomplete record set or invalid image metadata.
 */
function createManifest(records, identity) {
  requireRecord(records, 'the screenshot records')
  requireRecord(identity, 'the screenshot build identity')
  requireRecord(identity.source, 'the screenshot source identity')
  requireRecord(identity.runtime, 'the screenshot runtime identity')
  if (
    identity.source.algorithm !== 'sha256-path-length-content-v1' ||
    !Number.isInteger(identity.source.fileCount) ||
    identity.source.fileCount < 1 ||
    !/^[a-f0-9]{64}$/.test(identity.source.sha256 ?? '') ||
    identity.runtime.engine !== 'playwright-chromium' ||
    identity.runtime.platform !== 'linux-x86_64' ||
    !/^\d+\.\d+\.\d+$/.test(identity.runtime.playwright ?? '') ||
    !/^\d+$/.test(identity.runtime.chromiumRevision ?? '') ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(identity.runtime.chromiumVersion ?? '')
  ) {
    throw new Error('Provide the reviewed screenshot build identity.')
  }
  const images = {}
  for (const route of DOCUMENTATION_ROUTES) {
    const name = `${route.slug}.png`
    const record = requireRecord(records[name], name)
    if (
      record.route !== route.label ||
      record.state !== route.state ||
      !Number.isInteger(record.width) ||
      !Number.isInteger(record.height) ||
      !/^[a-f0-9]{64}$/.test(String(record.sha256 ?? ''))
    ) {
      throw new Error(`Provide valid verified metadata for ${name}.`)
    }
    images[name] = {
      source: 'deterministic-synthetic-application',
      route: route.label,
      state: route.state,
      command: CAPTURE_COMMAND,
      width: record.width,
      height: record.height,
      sha256: record.sha256,
    }
  }

  return {
    schemaVersion: 3,
    fixture: {
      id: 'supraspina-synthetic-documentation-v2',
      source: 'scripts/shot.cjs',
      dataClass: 'deterministic-synthetic',
      projectName: 'Synthetic documentation study',
      seed: 17,
      clock: '2026-07-22T16:00:00.000Z',
      theme: 'dark',
      density: 'Cozy',
      subjectCount: 12,
      subjectStateCoverage: ['done', 'running', 'failed', 'pending'],
      runStateCoverage: ['done', 'running', 'failed', 'blocked'],
      jobStateCoverage: ['done', 'running', 'queued', 'failed', 'blocked'],
      logLevelCoverage: ['INFO', 'WARN', 'ERROR'],
      qcVerdictCoverage: ['pass', 'fail', 'defer', 'unreviewed'],
      resultStateCoverage: [
        'produced',
        'partial',
        'expected',
        'absent',
        'unknown',
      ],
      diagnosticStateCoverage: [
        'found',
        'warning',
        'wrong version',
        'missing',
        'not checked',
      ],
      redactedDisplayFields: [
        'age and sex',
        'cohort',
        'AIS',
        'dates and times',
        'reviewer note',
      ],
      qcPanelPlaceholder: 'Synthetic QC panel',
      qcAnatomyIncluded: false,
      realParticipantDataIncluded: false,
    },
    reproduction: {
      command: CAPTURE_COMMAND,
      build: 'npm run build',
      outputDirectory: 'docs/screenshots',
      sourceIdentity: identity.source,
      runtimeIdentity: identity.runtime,
      viewport: {
        cssWidth: CSS_WIDTH,
        cssHeight: CSS_HEIGHT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
      },
    },
    images,
  }
}

async function requireRegularFile(file, errorMessage) {
  let info
  try {
    info = await fs.lstat(file)
  } catch {
    throw new Error(errorMessage)
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(errorMessage)
  }
  return info
}

async function readBoundedRegularFile(file, maximumBytes, errorMessage) {
  const info = await requireRegularFile(file, errorMessage)
  if (info.size > maximumBytes) throw new Error(errorMessage)
  return fs.readFile(file)
}

async function inspectPng(file) {
  const errorMessage = `Provide a valid bounded PNG at ${file}.`
  const bytes = await readBoundedRegularFile(file, MAX_PNG_BYTES, errorMessage)
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new Error(errorMessage)
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (
    width !== CSS_WIDTH * DEVICE_SCALE_FACTOR ||
    height !== CSS_HEIGHT * DEVICE_SCALE_FACTOR
  ) {
    throw new Error(
      `Capture ${path.basename(file)} at ${CSS_WIDTH * DEVICE_SCALE_FACTOR} by ${CSS_HEIGHT * DEVICE_SCALE_FACTOR} pixels.`,
    )
  }
  return {
    width,
    height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function verifyAccessibilityReport(file) {
  const errorMessage = `Provide a valid accessibility report at ${file}.`
  const bytes = await readBoundedRegularFile(
    file,
    MAX_AUDIT_BYTES,
    errorMessage,
  )
  let report
  try {
    report = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(errorMessage)
  }
  const findings = report?.applicationAudit?.findings
  if (
    !Array.isArray(report?.violations) ||
    !Array.isArray(report?.incomplete) ||
    !Array.isArray(findings) ||
    report.violations.length > 0 ||
    report.incomplete.length > 0 ||
    findings.length > 0
  ) {
    throw new Error(`Resolve every accessibility finding reported by ${file}.`)
  }
}

function runCapture(route, captureDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, captureArguments(route), {
      cwd: ROOT,
      env: {
        ...process.env,
        SUPRASPINA_SHOT_OUTDIR: captureDirectory,
      },
      stdio: 'inherit',
    })
    child.once('error', () => {
      reject(new Error(`Run the ${route.label} documentation capture.`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const reason = signal ? ` after signal ${signal}` : ` with exit ${code}`
      reject(new Error(`Resolve the ${route.label} capture failure${reason}.`))
    })
  })
}

async function captureRoute(route, captureDirectory) {
  console.log(`Capturing the ${route.label} documentation screen.`)
  await runCapture(route, captureDirectory)
  const imageName = `${route.slug}.png`
  const accessibilityName = `${route.slug}.accessibility.json`
  const image = await inspectPng(path.join(captureDirectory, imageName))
  await verifyAccessibilityReport(
    path.join(captureDirectory, accessibilityName),
  )
  return [
    imageName,
    {
      route: route.label,
      state: route.state,
      ...image,
    },
  ]
}

async function pathExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function verifyCompleteCapture(captureDirectory) {
  for (const name of REQUIRED_CAPTURE_NAMES) {
    await requireRegularFile(
      path.join(captureDirectory, name),
      'Provide the complete staged synthetic screenshot set.',
    )
  }
}

/**
 * Publish one complete staged screenshot set while preserving its README.
 *
 * @param {string} captureDirectory - The directory of a complete staged set.
 * @param {string} outputDirectory
 * @throws {Error} On equal or nested directories or an incomplete staged set.
 */
async function publishCapturedSet(captureDirectory, outputDirectory) {
  const capture = path.resolve(captureDirectory)
  const output = path.resolve(outputDirectory)
  if (
    capture === output ||
    capture.startsWith(`${output}${path.sep}`) ||
    output.startsWith(`${capture}${path.sep}`)
  ) {
    throw new Error('Provide distinct, nonnested capture directories.')
  }
  await verifyCompleteCapture(capture)

  const parent = path.dirname(output)
  await fs.mkdir(parent, { recursive: true })
  const candidate = await fs.mkdtemp(path.join(parent, '.screenshots-publish-'))
  let candidateExists = true
  let backup = null
  let movedExistingOutput = false

  try {
    for (const name of REQUIRED_CAPTURE_NAMES) {
      await fs.copyFile(path.join(capture, name), path.join(candidate, name))
    }

    if (await pathExists(output)) {
      const outputInfo = await fs.lstat(output)
      if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
        throw new Error('Provide a regular documentation output directory.')
      }
      const readme = path.join(output, README_NAME)
      if (await pathExists(readme)) {
        await requireRegularFile(
          readme,
          'Provide a regular documentation screenshot README.',
        )
        await fs.copyFile(readme, path.join(candidate, README_NAME))
      }

      backup = await fs.mkdtemp(path.join(parent, '.screenshots-previous-'))
      await fs.rmdir(backup)
      await fs.rename(output, backup)
      movedExistingOutput = true
    }

    try {
      await fs.rename(candidate, output)
      candidateExists = false
    } catch (error) {
      if (movedExistingOutput && backup) {
        await fs.rename(backup, output)
        movedExistingOutput = false
        backup = null
      }
      throw error
    }

    if (movedExistingOutput && backup) {
      await fs.rm(backup, { recursive: true, force: true })
      movedExistingOutput = false
      backup = null
    }
  } finally {
    if (candidateExists) {
      await fs.rm(candidate, { recursive: true, force: true })
    }
  }
}

async function main() {
  const captureDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'supraspina-synthetic-documentation-'),
  )
  try {
    const entries = []
    for (const route of DOCUMENTATION_ROUTES) {
      entries.push(await captureRoute(route, captureDirectory))
    }
    const records = Object.fromEntries(entries)
    const identity = {
      source: await documentationSourceIdentity(),
      runtime: await documentationRuntimeIdentity(),
    }
    const manifest = createManifest(records, identity)
    const manifestPath = path.join(captureDirectory, MANIFEST_NAME)
    const prettierOptions =
      (await prettier.resolveConfig(path.join(ROOT, 'package.json'))) ?? {}
    const serializedManifest = await prettier.format(JSON.stringify(manifest), {
      ...prettierOptions,
      filepath: manifestPath,
    })
    await fs.writeFile(manifestPath, serializedManifest, { flag: 'wx' })
    await publishCapturedSet(captureDirectory, OUTPUT_DIRECTORY)
    console.log(
      'Published the nine synthetic documentation screenshots in docs/screenshots.',
    )
  } finally {
    await fs.rm(captureDirectory, { recursive: true, force: true })
  }
}

module.exports = {
  CAPTURE_COMMAND,
  DOCUMENTATION_ROUTES,
  captureArguments,
  createManifest,
  publishCapturedSet,
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : 'Resolve the documentation capture failure.',
    )
    process.exitCode = 1
  })
}
