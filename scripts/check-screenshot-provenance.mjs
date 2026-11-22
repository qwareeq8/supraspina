#!/usr/bin/env node
/** Enforces deterministic, metadata-free documentation screenshot provenance. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import screenshotIdentity from './screenshot-source-identity.cjs'

const { documentationRuntimeIdentity, documentationSourceIdentity } =
  screenshotIdentity

const root = new URL('../', import.meta.url)
const screenshots = new URL('../docs/screenshots/', import.meta.url)
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_PNG_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const CAPTURE_COMMAND = 'npm run build && npm run screenshots:documentation'
const QC_PANEL_PLACEHOLDER = 'Synthetic QC panel'
const EXPECTED_SUBJECT_STATES = Object.freeze([
  'done',
  'running',
  'failed',
  'pending',
])
const EXPECTED_RUN_STATES = Object.freeze([
  'done',
  'running',
  'failed',
  'blocked',
])
const EXPECTED_JOB_STATES = Object.freeze([
  'done',
  'running',
  'queued',
  'failed',
  'blocked',
])
const EXPECTED_LOG_LEVELS = Object.freeze(['INFO', 'WARN', 'ERROR'])
const EXPECTED_QC_VERDICTS = Object.freeze([
  'pass',
  'fail',
  'defer',
  'unreviewed',
])
const EXPECTED_RESULT_STATES = Object.freeze([
  'produced',
  'partial',
  'expected',
  'absent',
  'unknown',
])
const EXPECTED_DIAGNOSTIC_STATES = Object.freeze([
  'found',
  'warning',
  'wrong version',
  'missing',
  'not checked',
])
const EXPECTED_REDACTED_FIELDS = Object.freeze([
  'age and sex',
  'cohort',
  'AIS',
  'dates and times',
  'reviewer note',
])
const EXPECTED_IMAGES = Object.freeze({
  'analysis.png': Object.freeze({ route: 'Analysis', state: 'populated' }),
  'analysis-grid.png': Object.freeze({
    route: 'Analysis',
    state: 'analysis-grid',
  }),
  'dashboard.png': Object.freeze({ route: 'Dashboard', state: 'populated' }),
  'diagnostics.png': Object.freeze({
    route: 'Diagnostics',
    state: 'populated',
  }),
  'logs.png': Object.freeze({ route: 'Logs', state: 'populated' }),
  'qc-review.png': Object.freeze({ route: 'QC review', state: 'populated' }),
  'results.png': Object.freeze({ route: 'Results', state: 'populated' }),
  'runs.png': Object.freeze({ route: 'Runs', state: 'populated' }),
  'subjects.png': Object.freeze({ route: 'Subjects', state: 'populated' }),
})
const EXPECTED_IMAGE_NAMES = Object.freeze(Object.keys(EXPECTED_IMAGES).sort())

/**
 * Read one file without exceeding its byte ceiling.
 *
 * @param {URL | string} file
 * @param {number} ceiling - The largest accepted size, in bytes.
 * @returns {Promise<Buffer>}
 * @throws {Error} On a file larger than the ceiling.
 */
export async function readBounded(file, ceiling) {
  const handle = await open(file, 'r')
  try {
    const chunks = []
    let total = 0
    while (total <= ceiling) {
      const buffer = Buffer.alloc(Math.min(1024 * 1024, ceiling + 1 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
    }
    if (total > ceiling) {
      throw new Error(
        `Keep ${basename(file.toString())} within ${ceiling} bytes.`,
      )
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}

function pngDetails(bytes) {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) {
    throw new Error('Provide a valid PNG.')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const chunks = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new Error('Provide complete PNG chunk data.')
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    chunks.push(type)
    offset = end
    if (type === 'IEND') break
  }
  if (
    chunks[0] !== 'IHDR' ||
    !chunks.includes('IDAT') ||
    chunks.at(-1) !== 'IEND' ||
    offset !== bytes.length
  ) {
    throw new Error('Remove trailing data and complete every PNG chunk.')
  }
  return { width, height, chunks }
}

/**
 * Verify one screenshot against its manifest record and PNG policy.
 *
 * @param {string} name - The image's manifest filename.
 * @param {{sha256: string, width: number, height: number}} record - The
 *   expected metadata.
 * @param {Buffer} bytes - The PNG bytes.
 * @throws {Error} On a digest, dimension, or metadata violation.
 */
export function validateScreenshotBytes(name, record, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== record.sha256) {
    throw new Error(`${name}: Match the committed SHA-256.`)
  }
  const { width, height, chunks } = pngDetails(bytes)
  if (width !== record.width || height !== record.height) {
    throw new Error(`${name}: Match the manifest dimensions.`)
  }
  const metadata = chunks.filter((chunk) => (chunk.charCodeAt(0) & 0x20) !== 0)
  if (metadata.length > 0) {
    throw new Error(`${name}: Remove PNG metadata (${metadata.join(', ')}).`)
  }
}

function trackedScreenshots() {
  return execFileSync('git', ['ls-files', '-z', 'docs/screenshots/*.png'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean)
    .map((path) => basename(path))
    .sort()
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(value ?? '')
}

function matchesExactStringList(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

function describeValue(value) {
  return value === undefined ? 'absent' : JSON.stringify(value)
}

function exactMismatch(field, actual, required) {
  return Object.is(actual, required)
    ? null
    : `${field} is ${describeValue(actual)} but must be ${describeValue(required)}.`
}

function listMismatch(field, actual, required) {
  return matchesExactStringList(actual, required)
    ? null
    : `${field} is ${describeValue(actual)} but must be ${describeValue(required)}.`
}

function formatMismatch(field, actual, requirement, accepted) {
  return accepted
    ? null
    : `${field} is ${describeValue(actual)} but must be ${requirement}.`
}

function driftMismatch(field, declared, computed) {
  return Object.is(declared, computed)
    ? null
    : `${field} declares ${describeValue(declared)} but this checkout computes ${describeValue(computed)}.`
}

/**
 * Verify the deterministic synthetic documentation declaration.
 *
 * @param {object} manifest - The parsed screenshot manifest.
 * @param {object} [expectedIdentity] - The source and runtime identities
 *   computed from this checkout.
 * @throws {Error} On real data, QC anatomy, or incomplete provenance,
 *   naming each mismatched field with its declared and required values.
 */
export function validateManifestDeclaration(
  manifest,
  expectedIdentity = manifest?.reproduction,
) {
  const fixture = manifest?.fixture ?? {}
  const reproduction = manifest?.reproduction ?? {}
  const source = reproduction.sourceIdentity ?? {}
  const runtime = reproduction.runtimeIdentity ?? {}
  const viewport = reproduction.viewport ?? {}
  const declared = [
    exactMismatch('schemaVersion', manifest?.schemaVersion, 3),
    exactMismatch(
      'fixture.id',
      fixture.id,
      'supraspina-synthetic-documentation-v2',
    ),
    exactMismatch('fixture.source', fixture.source, 'scripts/shot.cjs'),
    exactMismatch('fixture.seed', fixture.seed, 17),
    exactMismatch('fixture.clock', fixture.clock, '2026-07-22T16:00:00.000Z'),
    exactMismatch(
      'fixture.dataClass',
      fixture.dataClass,
      'deterministic-synthetic',
    ),
    exactMismatch('fixture.theme', fixture.theme, 'dark'),
    exactMismatch('fixture.density', fixture.density, 'Cozy'),
    exactMismatch(
      'fixture.projectName',
      fixture.projectName,
      'Synthetic documentation study',
    ),
    exactMismatch('fixture.subjectCount', fixture.subjectCount, 12),
    listMismatch(
      'fixture.subjectStateCoverage',
      fixture.subjectStateCoverage,
      EXPECTED_SUBJECT_STATES,
    ),
    listMismatch(
      'fixture.runStateCoverage',
      fixture.runStateCoverage,
      EXPECTED_RUN_STATES,
    ),
    listMismatch(
      'fixture.jobStateCoverage',
      fixture.jobStateCoverage,
      EXPECTED_JOB_STATES,
    ),
    listMismatch(
      'fixture.logLevelCoverage',
      fixture.logLevelCoverage,
      EXPECTED_LOG_LEVELS,
    ),
    listMismatch(
      'fixture.qcVerdictCoverage',
      fixture.qcVerdictCoverage,
      EXPECTED_QC_VERDICTS,
    ),
    listMismatch(
      'fixture.resultStateCoverage',
      fixture.resultStateCoverage,
      EXPECTED_RESULT_STATES,
    ),
    listMismatch(
      'fixture.diagnosticStateCoverage',
      fixture.diagnosticStateCoverage,
      EXPECTED_DIAGNOSTIC_STATES,
    ),
    listMismatch(
      'fixture.redactedDisplayFields',
      fixture.redactedDisplayFields,
      EXPECTED_REDACTED_FIELDS,
    ),
    exactMismatch(
      'fixture.qcPanelPlaceholder',
      fixture.qcPanelPlaceholder,
      QC_PANEL_PLACEHOLDER,
    ),
    exactMismatch(
      'fixture.qcAnatomyIncluded',
      fixture.qcAnatomyIncluded,
      false,
    ),
    exactMismatch(
      'fixture.realParticipantDataIncluded',
      fixture.realParticipantDataIncluded,
      false,
    ),
    exactMismatch(
      'reproduction.command',
      reproduction.command,
      CAPTURE_COMMAND,
    ),
    exactMismatch(
      'reproduction.sourceIdentity.algorithm',
      source.algorithm,
      'sha256-path-length-content-v1',
    ),
    formatMismatch(
      'reproduction.sourceIdentity.fileCount',
      source.fileCount,
      'a positive integer',
      Number.isInteger(source.fileCount) && source.fileCount >= 1,
    ),
    formatMismatch(
      'reproduction.sourceIdentity.sha256',
      source.sha256,
      'a lowercase 64-character SHA-256 digest',
      isSha256(source.sha256),
    ),
    exactMismatch(
      'reproduction.runtimeIdentity.engine',
      runtime.engine,
      'playwright-chromium',
    ),
    exactMismatch(
      'reproduction.runtimeIdentity.platform',
      runtime.platform,
      'linux-x86_64',
    ),
    formatMismatch(
      'reproduction.runtimeIdentity.playwright',
      runtime.playwright,
      'a three-part version number',
      /^\d+\.\d+\.\d+$/.test(runtime.playwright ?? ''),
    ),
    formatMismatch(
      'reproduction.runtimeIdentity.chromiumRevision',
      runtime.chromiumRevision,
      'a decimal revision number',
      /^\d+$/.test(runtime.chromiumRevision ?? ''),
    ),
    formatMismatch(
      'reproduction.runtimeIdentity.chromiumVersion',
      runtime.chromiumVersion,
      'a four-part version number',
      /^\d+\.\d+\.\d+\.\d+$/.test(runtime.chromiumVersion ?? ''),
    ),
    exactMismatch('reproduction.viewport.cssWidth', viewport.cssWidth, 1600),
    exactMismatch('reproduction.viewport.cssHeight', viewport.cssHeight, 1000),
    exactMismatch(
      'reproduction.viewport.deviceScaleFactor',
      viewport.deviceScaleFactor,
      2,
    ),
  ].filter(Boolean)
  if (declared.length > 0) {
    throw new Error(
      `Restore the deterministic synthetic dark-theme declaration: ${declared.join(' ')}`,
    )
  }
  const expectedSource = expectedIdentity?.sourceIdentity ?? {}
  const expectedRuntime = expectedIdentity?.runtimeIdentity ?? {}
  const drifted = [
    driftMismatch(
      'reproduction.sourceIdentity.algorithm',
      source.algorithm,
      expectedSource.algorithm,
    ),
    driftMismatch(
      'reproduction.sourceIdentity.fileCount',
      source.fileCount,
      expectedSource.fileCount,
    ),
    driftMismatch(
      'reproduction.sourceIdentity.sha256',
      source.sha256,
      expectedSource.sha256,
    ),
    driftMismatch(
      'reproduction.runtimeIdentity.engine',
      runtime.engine,
      expectedRuntime.engine,
    ),
    driftMismatch(
      'reproduction.runtimeIdentity.platform',
      runtime.platform,
      expectedRuntime.platform,
    ),
    driftMismatch(
      'reproduction.runtimeIdentity.playwright',
      runtime.playwright,
      expectedRuntime.playwright,
    ),
    driftMismatch(
      'reproduction.runtimeIdentity.chromiumRevision',
      runtime.chromiumRevision,
      expectedRuntime.chromiumRevision,
    ),
    driftMismatch(
      'reproduction.runtimeIdentity.chromiumVersion',
      runtime.chromiumVersion,
      expectedRuntime.chromiumVersion,
    ),
  ].filter(Boolean)
  if (drifted.length > 0) {
    throw new Error(
      `Recapture the documentation screenshots with \`${CAPTURE_COMMAND}\`: ${drifted.join(' ')}`,
    )
  }
}

function assertSourceInvariants(source, required, label) {
  for (const invariant of required) {
    if (!source.includes(invariant)) {
      throw new Error(`Restore the ${label} invariant: ${invariant}.`)
    }
  }
}

function validateCaptureSource(source) {
  assertSourceInvariants(
    source,
    [
      "'npm run build && npm run screenshots:documentation'",
      "'scripts/shot.cjs'",
      "label: 'Dashboard'",
      "label: 'Subjects'",
      "label: 'Runs'",
      "label: 'Logs'",
      "label: 'QC review'",
      "label: 'Results'",
      "label: 'Analysis'",
      "label: 'Diagnostics'",
      "'--documentation'",
      "'--dark'",
      "'--density'",
      "'Cozy'",
      "'--reduced-motion'",
      'const CSS_WIDTH = 1600',
      'const CSS_HEIGHT = 1000',
      'const DEVICE_SCALE_FACTOR = 2',
      '900',
      "'deterministic-synthetic-application'",
      "'deterministic-synthetic'",
      'qcAnatomyIncluded: false',
      'realParticipantDataIncluded: false',
      QC_PANEL_PLACEHOLDER,
      'await publishCapturedSet(',
    ],
    'documentation capture',
  )
  for (const forbidden of [
    'IRB-authorized',
    'authorized-real-run-application',
    'SUPRASPINA_SCREENSHOT_PROJECT',
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(
        `Remove the real-participant capture invariant: ${forbidden}.`,
      )
    }
  }
}

function validateFixtureSource(source) {
  assertSourceInvariants(
    source,
    [
      "const documentation = arg('documentation', false)",
      'openSyntheticProject(page, stateName, documentationMode)',
      "'Synthetic documentation study'",
      'const N = documentationMode ? 12 : 24',
      'let a = 17 | 0',
      "Date.parse('2026-07-22T16:00:00.000Z')",
      "'INFO'",
      "'WARN'",
      "'ERROR'",
      "'blocked'",
      "presence: 'partial'",
      "presence: 'expected'",
      "presence: 'absent'",
      "presence: 'unknown'",
      "'Redacted'",
      QC_PANEL_PLACEHOLDER,
      "'[data-qc-panel]'",
      'await openSyntheticProject(page, visualState, documentation)',
    ],
    'synthetic fixture',
  )
  // QC images stay plain placeholder tiles; nothing draws anatomy.
  if (/\.ellipse\(|\.arc\(/.test(source)) {
    throw new Error('Draw QC placeholder tiles without shapes in the fixture.')
  }
}

/**
 * Verify every tracked documentation screenshot and its source provenance.
 *
 * @returns {Promise<number>} The verified screenshot count.
 * @throws {Error} On a malformed manifest, an unsafe source, or a mismatched
 *   image.
 */
export async function checkScreenshotProvenance() {
  let manifest
  try {
    manifest = JSON.parse(
      (
        await readBounded(
          new URL('MANIFEST.json', screenshots),
          MAX_MANIFEST_BYTES,
        )
      ).toString('utf8'),
    )
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Provide a valid JSON screenshot manifest.', {
        cause: error,
      })
    }
    throw error
  }
  const [sourceIdentity, runtimeIdentity] = await Promise.all([
    documentationSourceIdentity(),
    documentationRuntimeIdentity(),
  ])
  validateManifestDeclaration(manifest, {
    sourceIdentity,
    runtimeIdentity,
  })

  const names = Object.keys(manifest.images ?? {}).sort()
  if (!matchesExactStringList(names, EXPECTED_IMAGE_NAMES)) {
    throw new Error(
      'List the nine approved documentation screenshots exactly once in MANIFEST.json.',
    )
  }
  if (!matchesExactStringList(trackedScreenshots(), EXPECTED_IMAGE_NAMES)) {
    throw new Error(
      'Track only the nine approved documentation screenshots in Git.',
    )
  }

  const [captureSource, fixtureSource] = await Promise.all([
    readBounded(
      new URL('scripts/capture-documentation-screenshots.cjs', root),
      MAX_SOURCE_BYTES,
    ),
    readBounded(new URL('scripts/shot.cjs', root), MAX_SOURCE_BYTES),
  ])
  validateCaptureSource(captureSource.toString('utf8'))
  validateFixtureSource(fixtureSource.toString('utf8'))

  for (const name of names) {
    const record = manifest.images[name]
    const expected = EXPECTED_IMAGES[name]
    if (
      !expected ||
      record?.source !== 'deterministic-synthetic-application' ||
      record.route !== expected.route ||
      record.state !== expected.state ||
      record.command !== CAPTURE_COMMAND ||
      record.width !== 3200 ||
      record.height !== 2000 ||
      !isSha256(record.sha256)
    ) {
      throw new Error(`${name}: Restore the deterministic provenance record.`)
    }
    validateScreenshotBytes(
      name,
      record,
      await readBounded(join(screenshots.pathname, name), MAX_PNG_BYTES),
    )
  }
  return names.length
}

/**
 * Format a completed screenshot-provenance check as a past-tense sentence.
 *
 * @param {number} count - The number of verified screenshots.
 * @returns {string}
 */
export function formatScreenshotProvenanceSuccess(count) {
  return `Verified screenshot provenance: ${count} deterministic synthetic dark-theme PNGs.`
}

/**
 * Format a failed screenshot-provenance check as one actionable line.
 *
 * @param {unknown} error - The error that ended the check.
 * @returns {string}
 */
export function formatScreenshotProvenanceFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return `check-screenshot-provenance: ${message.trim() || 'The screenshot-provenance check failed.'}`
}

/**
 * Run the screenshot-provenance gate as a command-line entry point.
 *
 * @param {{check?: Function, stdout?: {write: Function}, stderr?: {write:
 *   Function}}} [io] - The check to run and the streams that receive its
 *   output lines.
 * @returns {Promise<number>} The exit code: 0 on success and 1 on a failed
 *   check.
 */
export async function main({
  check = checkScreenshotProvenance,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const count = await check()
    stdout.write(`${formatScreenshotProvenanceSuccess(count)}\n`)
    return 0
  } catch (error) {
    stderr.write(`${formatScreenshotProvenanceFailure(error)}\n`)
    return 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main()
}
