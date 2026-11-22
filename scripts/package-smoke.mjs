#!/usr/bin/env node
/**
 * Launches a packaged Supraspina executable and verifies its path-free smoke
 * report.
 *
 * The application performs the runtime assertions. This direct-launch harness
 * gives it an isolated user-data directory, verifies bounded process-tree exit,
 * and prints one deterministic result without exposing local paths.
 */

import { execFile, spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

/** The path-free application-report prefix. */
export const PACKAGE_SMOKE_SENTINEL = 'SUPRASPINA_PACKAGE_SMOKE_RESULT='
/** The path-free verified-result prefix. */
export const PACKAGE_SMOKE_VERIFIED = 'SUPRASPINA_PACKAGE_SMOKE_VERIFIED='
export const NATIVE_SCIENCE_ACCEPTANCE_MARKER =
  'SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE'

const PACKAGE_SMOKE_FLAG = '--supraspina-smoke-test'
/** An unreachable renderer URL that a packaged build must ignore. */
export const PACKAGE_SMOKE_RENDERER_POISON = 'https://127.0.0.1:9/attacker'
const DEFAULT_TIMEOUT_MS = 60_000
const MIN_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_NATIVE_SCIENCE_TIMEOUT_MS = 45 * 60 * 1_000
const MAX_NATIVE_SCIENCE_TIMEOUT_MS = 60 * 60 * 1_000
const PROCESS_EXIT_TIMEOUT_MS = 8_000
const PROCESS_TABLE_TIMEOUT_MS = 2_000
const PROCESS_IDENTITY_RETRY_TIMEOUT_MS = 500
const PROCESS_IDENTITY_RETRY_DELAY_MS = 20
const PROCESS_TABLE_MAX_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_REPORT_OUTPUT_BYTES = 1024 * 1024
const USER_DATA_CLEANUP_TIMEOUT_MS = 5_000
const USER_NAMESPACE_PROBE_TIMEOUT_MS = 2_000
const PROCESS_OWNERSHIP_TOKEN = 'SUPRASPINA_SMOKE_PROCESS_TOKEN'
const PROCESS_IDENTITY_FALLBACK_KEY =
  'supraspina-package-smoke-process-identity-v1'
const ARTIFACT_TYPES = new Set(['appimage', 'deb', 'unpacked'])
const SMOKE_REASON_TAGS = new Set([
  'capture-ambiguous-birth',
  'capture-ambiguous-birth-persistent',
  'cleanup-quarantine-unresolved',
  'cleanup-terminate-identity',
  'process-table-identity',
  'tracker-load-identity',
  'tracker-match-identity',
  'tracker-post-register-identity',
  'tracker-refresh-identity',
  'tracker-register-group-identity',
  'tracker-register-root-identity',
  'tracker-sample-identity',
  'tracker-stop-identity',
])
const REPORT_PLATFORMS = new Set(['linux', 'darwin', 'win32'])
const REPORT_FAILURE_CODES = new Set([
  null,
  'launch-policy',
  'packaged-paths',
  'sidecar-handshake',
  'renderer-start',
  'renderer-probe',
  'runtime-contract',
  'diagnostics',
  'shutdown',
])
const REPORT_CHECK_NAMES = [
  'packagedMode',
  'noSandboxPolicy',
  'resourcesPathAbsolute',
  'appAsar',
  'rendererEntryInAsar',
  'preloadEntryInAsar',
  'externalIcon',
  'frozenSidecarLauncher',
  'frozenSidecarRuntime',
  'frozenSidecarExecutable',
  'bundledMicromamba',
  'bundledMicromambaExecutable',
  'noDeveloperOverrides',
  'rendererPoisonIgnored',
  'firstPartyLicense',
  'thirdPartyNotices',
  'thirdPartyProvenance',
  'dependencyManifests',
  'scientificAcquisitionMetadata',
  'unresolvedUpstreamAssetsExcluded',
  'mainStarted',
  'rendererStarted',
  'preloadBridge',
  'rendererSandboxed',
  'hostIpcRoundTrip',
  'sidecarHandshake',
  'safeNoProject',
  'clinicalOpenpyxlRuntime',
  'clinicalDiscoveryDone',
  'clinicalRefreshDone',
  'clinicalMissingColumnsRejected',
  'clinicalEmptyRequiredRejected',
  'clinicalMalformedRejected',
  'clinicalMissingDependencyRejected',
  'clinicalLiveZeroExit',
  'clinicalReceiptDurable',
  'clinicalBrainpadEligible',
  'clinicalOutputReopened',
  'nativeScienceRequested',
  'pybrainageProvisioned',
  'pybrainageReady',
  'pybrainagePredictionReopened',
  'clinicalProjectDetached',
  'clinicalTemporaryDataRemoved',
  'updaterIdle',
  'noUpdateNetwork',
  'rendererLocalResources',
  'computerModernFaces',
  'fontSynthesisDisabled',
  'noProcessErrors',
  'noRendererErrors',
  'noSensitiveDiagnostics',
  'sidecarStopped',
]
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const EXPECTED_PRODUCT_VERSION = require('../package.json').version

class SmokeHarnessError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SmokeHarnessError'
    this.code = code
  }
}

/**
 * Accept one enumerated path-free smoke-failure reason tag.
 *
 * @param {unknown} value
 * @returns {string | null} The tag, or null when it is not an enumerated
 *   reason.
 */
export function safeSmokeReasonTag(value) {
  return typeof value === 'string' && SMOKE_REASON_TAGS.has(value)
    ? value
    : null
}

function tagSmokeError(error, reasonTag) {
  if (
    error instanceof SmokeHarnessError &&
    safeSmokeReasonTag(reasonTag) !== null &&
    safeSmokeReasonTag(error.reasonTag) === null
  ) {
    error.reasonTag = reasonTag
  }
  return error
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new SmokeHarnessError(`missing-${flag.slice(2)}`)
  }
  return value
}

function isCi(env) {
  return env.CI === 'true' || env.CI === '1'
}

function validateArtifactPlatform(platform) {
  // Ship only Linux artifacts, so refuse to smoke any of them from another host.
  if (platform !== 'linux') {
    throw new SmokeHarnessError('artifact-platform-mismatch')
  }
}

/**
 * Mirror AppRun's fail-safe user-namespace probe for package-smoke authorization.
 *
 * @param {string} artifactType
 * @param {NodeJS.Platform} [platform]
 * @param {object} [dependencies] - Injected command dependencies.
 * @returns {Promise<boolean>} Whether AppRun will disable the sandbox.
 */
export async function appImageLauncherNeedsNoSandbox(
  artifactType,
  platform = process.platform,
  dependencies = {},
) {
  if (artifactType !== 'appimage' || platform !== 'linux') return false
  const execute = dependencies.execFile ?? execFileAsync
  try {
    await execute('unshare', ['-Ur', 'true'], {
      timeout: USER_NAMESPACE_PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    return false
  } catch {
    return true
  }
}

/**
 * Parse and validate the explicit executable, artifact, and sandbox options.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @returns {object} Either the help selection or the validated launch
 *   options.
 * @throws {Error} On unknown, missing, unsafe, or platform-incompatible options.
 * @example
 * parsePackageSmokeArguments(['--executable', '/opt/Supraspina', '--type', 'unpacked'])
 */
export function parsePackageSmokeArguments(
  argv,
  env = process.env,
  platform = process.platform,
) {
  let executable = env.SUPRASPINA_SMOKE_EXECUTABLE || ''
  let artifactType = env.SUPRASPINA_SMOKE_ARTIFACT_TYPE || ''
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let noSandboxFlag = false
  let nativeScience = false
  let timeoutProvided = false
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--executable':
        executable = requiredValue(argv, index, argument)
        index += 1
        break
      case '--type':
        artifactType = requiredValue(argv, index, argument)
        index += 1
        break
      case '--timeout-ms':
        timeoutMs = Number(requiredValue(argv, index, argument))
        timeoutProvided = true
        index += 1
        break
      case '--native-science':
        nativeScience = true
        break
      case '--no-sandbox':
        noSandboxFlag = true
        break
      case '--help':
        help = true
        break
      default:
        throw new SmokeHarnessError('unknown-argument')
    }
  }

  if (help) return { help: true }
  if (!executable) throw new SmokeHarnessError('missing-executable')
  if (!ARTIFACT_TYPES.has(artifactType)) {
    throw new SmokeHarnessError('invalid-artifact-type')
  }
  if (nativeScience && !timeoutProvided) {
    timeoutMs = DEFAULT_NATIVE_SCIENCE_TIMEOUT_MS
  }
  const maximumTimeout = nativeScience
    ? MAX_NATIVE_SCIENCE_TIMEOUT_MS
    : MAX_TIMEOUT_MS
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > maximumTimeout
  ) {
    throw new SmokeHarnessError('invalid-timeout')
  }

  validateArtifactPlatform(platform)
  const allowNoSandbox =
    noSandboxFlag || env.SUPRASPINA_SMOKE_NO_SANDBOX === '1'
  if (allowNoSandbox && (platform !== 'linux' || !isCi(env))) {
    throw new SmokeHarnessError('no-sandbox-requires-linux-ci')
  }

  return {
    help: false,
    executable: resolve(executable),
    artifactType,
    timeoutMs,
    allowNoSandbox,
    nativeScience,
  }
}

/**
 * Build only the arguments owned by the smoke harness.
 *
 * @param {object} options
 * @param {string} options.userDataDir - The isolated user-data directory.
 * @param {boolean} options.allowNoSandbox - Whether to apply the explicit Linux
 *   CI sandbox exception.
 * @returns {string[]}
 */
export function buildElectronLaunchArgs({ userDataDir, allowNoSandbox }) {
  const args = [PACKAGE_SMOKE_FLAG, `--user-data-dir=${userDataDir}`]
  if (allowNoSandbox) args.push('--no-sandbox')
  return args
}

/**
 * Build a sanitized child environment for the packaged application.
 *
 * @param {boolean} allowNoSandbox - Whether to apply the explicit Linux CI
 *   sandbox exception.
 * @param {string | undefined} ownershipToken - The private process-ownership
 *   token.
 * @returns {NodeJS.ProcessEnv}
 */
export function smokeChildEnvironment(
  allowNoSandbox,
  ownershipToken,
  nativeScience = false,
  launcherNeedsNoSandbox = false,
) {
  const env = { ...process.env }
  env.ELECTRON_RENDERER_URL = PACKAGE_SMOKE_RENDERER_POISON
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.SUPRASPINA_SIDECAR
  delete env.SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX
  delete env[PROCESS_OWNERSHIP_TOKEN]
  delete env[NATIVE_SCIENCE_ACCEPTANCE_MARKER]
  env.SUPRASPINA_PACKAGE_SMOKE = '1'
  if (ownershipToken) env[PROCESS_OWNERSHIP_TOKEN] = ownershipToken
  if (allowNoSandbox || launcherNeedsNoSandbox) {
    env.SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX = '1'
  }
  if (launcherNeedsNoSandbox) env.CI = 'true'
  if (nativeScience) env[NATIVE_SCIENCE_ACCEPTANCE_MARKER] = '1'
  return env
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

/**
 * Reject path, study-identity, credential, and contact material.
 *
 * @param {unknown} value
 * @returns {boolean} Whether the value contains sensitive material.
 */
export function containsSensitiveSmokeDiagnostic(value) {
  let text
  if (value instanceof Error) {
    text = value.message
  } else if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }

  return [
    /file:\/\//i,
    /(?:^|[\s"'(=])\/(?!\/)[^\s"'()]+/,
    /\b[A-Za-z]:[\\/]/,
    /\\\\[^\s\\]+\\/,
    /\bsub-[A-Za-z0-9][A-Za-z0-9_-]*\b/i,
    /\b(?:participant|patient)[_-]?(?:id|name)\b/i,
    /\b(?:medical[_-]?record|mrn|date[_-]?of[_-]?birth)\b/i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\bbearer\s+[A-Za-z0-9._~+/=-]+/i,
    /\b(?:authorization|password|api[_-]?key|access[_-]?token|secret)\s*[:=]/i,
  ].some((pattern) => pattern.test(text))
}

/**
 * Accept only the fixed, boolean-only report schema.
 *
 * Require exact keys and enumerated strings to prevent a packaged app from adding a
 * free-form diagnostic field that the harness would otherwise echo to logs.
 *
 * @param {unknown} value
 * @param {NodeJS.Platform} [expectedPlatform]
 * @returns {boolean} Whether the report matches the fixed path-free schema.
 */
export function validAppReport(
  value,
  expectedPlatform = process.platform,
  expectedNativeScience = false,
) {
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'productVersion',
      'sidecarProductVersion',
      'ok',
      'platform',
      'failureCode',
      'checks',
    ]) ||
    value.schemaVersion !== 1 ||
    value.productVersion !== EXPECTED_PRODUCT_VERSION ||
    value.sidecarProductVersion !== EXPECTED_PRODUCT_VERSION ||
    typeof value.ok !== 'boolean' ||
    !REPORT_PLATFORMS.has(value.platform) ||
    value.platform !== expectedPlatform ||
    !REPORT_FAILURE_CODES.has(value.failureCode) ||
    !hasExactKeys(value.checks, REPORT_CHECK_NAMES) ||
    REPORT_CHECK_NAMES.some(
      (name) => typeof value.checks[name] !== 'boolean',
    ) ||
    containsSensitiveSmokeDiagnostic(value)
  ) {
    return false
  }

  if (value.checks.nativeScienceRequested !== expectedNativeScience) {
    return false
  }
  const nativeChecks = new Set([
    'nativeScienceRequested',
    'pybrainageProvisioned',
    'pybrainageReady',
    'pybrainagePredictionReopened',
  ])
  const ordinaryChecksPass = REPORT_CHECK_NAMES.every(
    (name) => nativeChecks.has(name) || value.checks[name],
  )
  const nativeChecksPass =
    !expectedNativeScience ||
    (value.checks.pybrainageProvisioned &&
      value.checks.pybrainageReady &&
      value.checks.pybrainagePredictionReopened)
  const allChecksPass = ordinaryChecksPass && nativeChecksPass
  return (
    value.ok === allChecksPass &&
    (value.ok ? value.failureCode === null : value.failureCode !== null)
  )
}

/**
 * Attach to stdout before the process can publish its one path-free report.
 *
 * Spawn directly to avoid Playwright's main-process inspector, which otherwise
 * becomes part of Electron shutdown. Never let the bounded collector echo child
 * output; reject duplicate, malformed, oversized, or missing reports.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs - The report timeout in milliseconds.
 * @param {NodeJS.Platform} [expectedPlatform]
 * @returns {object} The bounded report promise and cleanup controls.
 * @throws {Error} On a child without a readable stdout stream.
 */
export function startAppReportCapture(
  child,
  timeoutMs,
  expectedPlatform = process.platform,
  expectedNativeScience = false,
) {
  const output = child.stdout
  if (!output || typeof output.on !== 'function') {
    throw new SmokeHarnessError('app-stdout-missing')
  }

  let buffer = ''
  let byteCount = 0
  let report = null
  let failure = null
  let settled = false
  let outputEnded = false
  let resolveReport
  let rejectReport
  let resolveOutputEnd

  const reportPromise = new Promise((resolveValue, rejectValue) => {
    resolveReport = resolveValue
    rejectReport = rejectValue
  })
  const outputEndPromise = new Promise((resolveEnd) => {
    resolveOutputEnd = resolveEnd
  })

  const fail = (code) => {
    if (!failure) failure = new SmokeHarnessError(code)
    if (settled) return
    settled = true
    clearTimeout(timer)
    rejectReport(failure)
  }

  const acceptLine = (line) => {
    // AppImage's extract-and-run fallback writes unsquashfs paths to the same
    // pipe, and a path fragment can land just before the sentinel. Discard
    // that prefix and validate only the exact, path-free JSON schema.
    const sentinelIndex = line.indexOf(PACKAGE_SMOKE_SENTINEL)
    if (sentinelIndex < 0) return
    if (report !== null) {
      fail('duplicate-app-report')
      return
    }
    let candidate
    try {
      candidate = JSON.parse(
        line.slice(sentinelIndex + PACKAGE_SMOKE_SENTINEL.length),
      )
    } catch {
      fail('invalid-app-report')
      return
    }
    if (!validAppReport(candidate, expectedPlatform, expectedNativeScience)) {
      fail('invalid-app-report')
      return
    }
    report = candidate
    if (!settled) {
      settled = true
      clearTimeout(timer)
      resolveReport(candidate)
    }
  }

  const consumeCompleteLines = () => {
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      acceptLine(line)
      newline = buffer.indexOf('\n')
    }
  }

  const onData = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    byteCount += Buffer.byteLength(text)
    if (byteCount > MAX_REPORT_OUTPUT_BYTES) {
      fail('app-report-output-too-large')
      return
    }
    buffer += text
    consumeCompleteLines()
  }
  const onError = () => fail('electron-launch-failed')
  const onOutputError = () => {
    fail('app-output-error')
    outputEnded = true
    resolveOutputEnd()
  }
  const onEnd = () => {
    if (buffer.length > 0) {
      if (buffer.startsWith(PACKAGE_SMOKE_SENTINEL)) {
        fail('unterminated-app-report')
      }
      buffer = ''
    }
    if (report === null && !failure) fail('app-report-missing')
    outputEnded = true
    resolveOutputEnd()
  }
  const timer = setTimeout(() => fail('app-report-timeout'), timeoutMs)

  output.setEncoding?.('utf8')
  output.on('data', onData)
  output.once('error', onOutputError)
  output.once('end', onEnd)
  child.once('error', onError)

  return {
    report: reportPromise,
    async finish(finishTimeoutMs) {
      if (!outputEnded) {
        let finishTimer
        await Promise.race([
          outputEndPromise,
          new Promise((_, rejectFinish) => {
            finishTimer = setTimeout(
              () =>
                rejectFinish(new SmokeHarnessError('app-output-close-timeout')),
              finishTimeoutMs,
            )
          }),
        ]).finally(() => {
          if (finishTimer) clearTimeout(finishTimer)
        })
      }
      this.stop()
      if (failure) throw failure
      if (report === null) throw new SmokeHarnessError('app-report-missing')
      return report
    },
    stop() {
      clearTimeout(timer)
      output.off('data', onData)
      output.off('error', onOutputError)
      output.off('end', onEnd)
      child.off('error', onError)
      buffer = ''
    },
  }
}

function processMetadataFromLine(line) {
  const match = line.match(
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/,
  )
  if (!match) return null

  const metadata = {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    processGroupId: Number(match[3]),
    userId: Number(match[4]),
    startedAt: match[5].replace(/\s+/g, ' '),
  }
  if (
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    !Number.isSafeInteger(metadata.parentPid) ||
    metadata.parentPid < 0 ||
    !Number.isSafeInteger(metadata.processGroupId) ||
    metadata.processGroupId < 0 ||
    !Number.isSafeInteger(metadata.userId) ||
    metadata.userId < 0
  ) {
    return null
  }
  return { metadata, tail: match[6] ?? '' }
}

function ownershipMarkerPattern(ownershipToken) {
  if (!ownershipToken) return null
  const ownershipMarker = `${PROCESS_OWNERSHIP_TOKEN}=${ownershipToken}`
  return new RegExp(
    `(?:^|\\s)${ownershipMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`,
  )
}

function parseOwnershipProcessTable(stdout, ownershipToken) {
  const markerPattern = ownershipMarkerPattern(ownershipToken)
  const entries = []
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = processMetadataFromLine(line)
    if (!parsed) {
      if (markerPattern?.test(line)) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      continue
    }
    entries.push({
      ...parsed.metadata,
      ownershipTokenMatched:
        markerPattern !== null && markerPattern.test(parsed.tail),
    })
  }
  return entries
}

function parseSafeProcessTable(stdout) {
  const entries = []
  const invalidPids = new Set()
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = processMetadataFromLine(line)
    if (!parsed) {
      const pid = Number(line.match(/^\s*(\d+)(?:\s|$)/)?.[1])
      if (Number.isSafeInteger(pid) && pid > 0) invalidPids.add(pid)
      continue
    }
    entries.push({
      ...parsed.metadata,
      command: parsed.tail.trim(),
    })
  }
  return { entries, invalidPids }
}

function indexProcessEntries(entries) {
  const byPid = new Map()
  for (const entry of entries) {
    if (byPid.has(entry.pid)) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    byPid.set(entry.pid, entry)
  }
  return byPid
}

function sameProcessMetadata(left, right) {
  return (
    left.pid === right.pid &&
    left.parentPid === right.parentPid &&
    left.processGroupId === right.processGroupId &&
    left.userId === right.userId &&
    left.startedAt === right.startedAt
  )
}

function capturedOwnedProcessIds(entries, requiredPids) {
  const byPid = indexProcessEntries(entries)
  const ownedPids = new Set()
  for (const entry of entries) {
    if (entry.ownershipTokenMatched || requiredPids.has(entry.pid)) {
      ownedPids.add(entry.pid)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const entry of entries) {
      const parent = byPid.get(entry.parentPid)
      if (
        ownedPids.has(entry.parentPid) &&
        parent?.userId === entry.userId &&
        !ownedPids.has(entry.pid)
      ) {
        ownedPids.add(entry.pid)
        changed = true
      }
    }
  }
  return ownedPids
}

function survivingCapturedDescendantPids(
  ancestorPid,
  capturedPids,
  ownershipByPid,
  safeByPid,
) {
  const descendants = new Set()
  for (const pid of capturedPids) {
    if (pid === ancestorPid || !safeByPid.has(pid)) continue
    const visited = new Set()
    let current = ownershipByPid.get(pid)
    while (current && !visited.has(current.pid)) {
      if (current.parentPid === ancestorPid) {
        descendants.add(pid)
        break
      }
      visited.add(current.pid)
      current = ownershipByPid.get(current.parentPid)
    }
  }
  return descendants
}

function retainedTokenTransition(ownershipEntry, safeEntry, retainedRecords) {
  if (
    ownershipEntry.ownershipTokenMatched !== true ||
    safeEntry.command.length === 0 ||
    ownershipEntry.pid !== safeEntry.pid ||
    ownershipEntry.userId !== safeEntry.userId ||
    ownershipEntry.startedAt !== safeEntry.startedAt
  ) {
    return null
  }
  const matches = retainedRecords.filter(
    (record) =>
      record.ownershipBasis === 'token' &&
      record.pid === ownershipEntry.pid &&
      record.userId === ownershipEntry.userId &&
      record.startedAt === ownershipEntry.startedAt,
  )
  return matches.length === 1 ? matches[0] : null
}

function retainedAncestryReparentCandidates(
  ownershipEntries,
  safeCapture,
  requiredPids,
  retainedRecords,
  dependencies = {},
) {
  if ((dependencies.platform ?? process.platform) !== 'linux') return new Map()
  const ownershipByPid = indexProcessEntries(ownershipEntries)
  const safeByPid = indexProcessEntries(safeCapture.entries)
  const candidates = new Map()

  for (const pid of requiredPids) {
    const ownershipEntry = ownershipByPid.get(pid)
    const safeEntry = safeByPid.get(pid)
    if (
      !ownershipEntry ||
      !safeEntry ||
      ownershipEntry.pid !== safeEntry.pid ||
      ownershipEntry.processGroupId !== safeEntry.processGroupId ||
      ownershipEntry.userId !== safeEntry.userId ||
      ownershipEntry.startedAt !== safeEntry.startedAt ||
      safeEntry.command.length === 0
    ) {
      continue
    }
    const matches = retainedRecords.filter(
      (record) =>
        record.ownershipBasis === 'ancestry' &&
        record.pid === ownershipEntry.pid &&
        record.processGroupId === ownershipEntry.processGroupId &&
        record.userId === ownershipEntry.userId &&
        record.startedAt === ownershipEntry.startedAt &&
        /^linux:\d+$/.test(record.startIdentity),
    )
    if (matches.length === 1) candidates.set(pid, matches[0])
  }
  return candidates
}

function retainedLinuxTokenTransitionCandidates(
  ownershipEntries,
  safeCapture,
  requiredPids,
  retainedRecords,
  platform,
) {
  if (platform !== 'linux') return new Map()
  const ownershipByPid = indexProcessEntries(ownershipEntries)
  const safeByPid = indexProcessEntries(safeCapture.entries)
  const candidates = new Map()
  for (const pid of requiredPids) {
    const ownershipEntry = ownershipByPid.get(pid)
    const safeEntry = safeByPid.get(pid)
    if (
      !ownershipEntry ||
      !safeEntry ||
      sameProcessMetadata(ownershipEntry, safeEntry) ||
      ownershipEntry.userId !== safeEntry.userId ||
      ownershipEntry.startedAt !== safeEntry.startedAt ||
      safeEntry.command.length === 0
    ) {
      continue
    }
    const matches = retainedRecords.filter(
      (record) =>
        record.ownershipBasis === 'token' &&
        record.pid === pid &&
        record.userId === safeEntry.userId &&
        record.startedAt === safeEntry.startedAt &&
        /^linux:\d+$/.test(record.startIdentity),
    )
    if (matches.length === 1) candidates.set(pid, matches[0])
  }
  return candidates
}

function mergeProcessCaptures(
  ownershipEntries,
  safeCapture,
  requiredPids,
  retainedRecords,
  confirmationEntries = null,
  validatedAncestryReparents = new Set(),
  validatedDurableTokenTransitions = new Set(),
) {
  const ownershipByPid = indexProcessEntries(ownershipEntries)
  const safeByPid = indexProcessEntries(safeCapture.entries)
  const capturedPids = capturedOwnedProcessIds(ownershipEntries, requiredPids)
  const confirmationByPid = confirmationEntries
    ? indexProcessEntries(confirmationEntries)
    : new Map()
  const confirmedPids = confirmationEntries
    ? capturedOwnedProcessIds(confirmationEntries, requiredPids)
    : new Set()
  const capturedGroups = new Set(
    [...ownershipEntries, ...(confirmationEntries ?? [])]
      .filter(
        (entry) => capturedPids.has(entry.pid) || confirmedPids.has(entry.pid),
      )
      .map((entry) => entry.processGroupId),
  )
  const reconciledPids = new Set()
  const tokenReconciledPids = new Set()
  const vanishedAncestorPids = new Set()
  for (const pid of requiredPids) {
    if (!ownershipByPid.has(pid) && safeByPid.has(pid)) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    if (!ownershipByPid.has(pid) && safeCapture.invalidPids.has(pid)) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    if (
      ownershipByPid.has(pid) &&
      safeByPid.has(pid) &&
      !sameProcessMetadata(ownershipByPid.get(pid), safeByPid.get(pid))
    ) {
      const retained = retainedTokenTransition(
        ownershipByPid.get(pid),
        safeByPid.get(pid),
        retainedRecords,
      )
      const ancestryReparent = validatedAncestryReparents.has(pid)
      const durableToken = validatedDurableTokenTransitions.has(pid)
      if (!retained && !ancestryReparent && !durableToken) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      if (confirmationEntries) {
        const confirmation = confirmationByPid.get(pid)
        if (
          !confirmation ||
          (retained &&
            !durableToken &&
            confirmation.ownershipTokenMatched !== true) ||
          !sameProcessMetadata(confirmation, safeByPid.get(pid))
        ) {
          throw new SmokeHarnessError('process-identity-unproved')
        }
      }
      if (retained && !durableToken) tokenReconciledPids.add(pid)
      reconciledPids.add(pid)
      capturedGroups.add(safeByPid.get(pid).processGroupId)
    }
  }

  for (const ownershipEntry of ownershipEntries) {
    if (
      !capturedPids.has(ownershipEntry.pid) ||
      safeByPid.has(ownershipEntry.pid)
    ) {
      continue
    }
    if (safeCapture.invalidPids.has(ownershipEntry.pid)) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    const survivingDescendants = survivingCapturedDescendantPids(
      ownershipEntry.pid,
      capturedPids,
      ownershipByPid,
      safeByPid,
    )
    if (survivingDescendants.size === 0) continue
    const descendantsHaveTransitionProof = [...survivingDescendants].every(
      (pid) => {
        const ownershipDescendant = ownershipByPid.get(pid)
        const safeDescendant = safeByPid.get(pid)
        return (
          validatedAncestryReparents.has(pid) ||
          validatedDurableTokenTransitions.has(pid) ||
          retainedTokenTransition(
            ownershipDescendant,
            safeDescendant,
            retainedRecords,
          ) !== null
        )
      },
    )
    if (
      !descendantsHaveTransitionProof ||
      (confirmationEntries && confirmationByPid.has(ownershipEntry.pid))
    ) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    vanishedAncestorPids.add(ownershipEntry.pid)
  }

  if (confirmationEntries) {
    for (const pid of capturedPids) {
      const ownershipEntry = ownershipByPid.get(pid)
      const safeEntry = safeByPid.get(pid)
      if (!safeEntry) {
        if (vanishedAncestorPids.has(pid) && !confirmationByPid.has(pid)) {
          continue
        }
        throw new SmokeHarnessError('process-identity-unproved')
      }
      if (
        safeEntry.command.length === 0 ||
        (!sameProcessMetadata(ownershipEntry, safeEntry) &&
          !reconciledPids.has(pid))
      ) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
    }
    for (const pid of confirmedPids) {
      const confirmation = confirmationByPid.get(pid)
      const safeEntry = safeByPid.get(pid)
      if (
        !safeEntry ||
        safeEntry.command.length === 0 ||
        !sameProcessMetadata(confirmation, safeEntry)
      ) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
    }
  }

  const merged = []

  for (const ownershipEntry of ownershipEntries) {
    const isRequired = capturedPids.has(ownershipEntry.pid)
    const safeEntry = safeByPid.get(ownershipEntry.pid)
    if (!safeEntry) {
      if (isRequired && safeCapture.invalidPids.has(ownershipEntry.pid)) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      continue
    }
    if (!sameProcessMetadata(ownershipEntry, safeEntry)) {
      if (
        !reconciledPids.has(ownershipEntry.pid) ||
        (confirmationEntries &&
          tokenReconciledPids.has(ownershipEntry.pid) &&
          confirmationByPid.get(ownershipEntry.pid)?.ownershipTokenMatched !==
            true)
      ) {
        if (isRequired) {
          throw new SmokeHarnessError('process-identity-unproved')
        }
        continue
      }
      merged.push({
        ...safeEntry,
        ownershipTokenMatched:
          tokenReconciledPids.has(ownershipEntry.pid) ||
          (validatedDurableTokenTransitions.has(ownershipEntry.pid) &&
            confirmationByPid.get(ownershipEntry.pid)?.ownershipTokenMatched ===
              true),
      })
      continue
    }
    if (safeEntry.command.length === 0) {
      if (isRequired) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      continue
    }
    merged.push({
      ...ownershipEntry,
      command: safeEntry.command,
    })
  }

  const mergedByPid = new Map(merged.map((entry) => [entry.pid, entry]))
  if (confirmationEntries) {
    for (const pid of confirmedPids) {
      if (mergedByPid.has(pid)) continue
      const confirmation = confirmationByPid.get(pid)
      const safeEntry = safeByPid.get(pid)
      const retainedAncestry = retainedRecords.some(
        (record) =>
          record.ownershipBasis === 'ancestry' &&
          record.pid === confirmation.pid &&
          record.userId === confirmation.userId &&
          record.startedAt === confirmation.startedAt,
      )
      const entry = {
        ...safeEntry,
        ownershipTokenMatched:
          confirmation.ownershipTokenMatched === true && !retainedAncestry,
      }
      merged.push(entry)
      mergedByPid.set(entry.pid, entry)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const safeEntry of safeCapture.entries) {
      if (ownershipByPid.has(safeEntry.pid) || mergedByPid.has(safeEntry.pid)) {
        continue
      }
      const parent = mergedByPid.get(safeEntry.parentPid)
      if (
        !parent ||
        parent.userId !== safeEntry.userId ||
        safeEntry.command.length === 0
      ) {
        continue
      }
      const entry = { ...safeEntry, ownershipTokenMatched: false }
      merged.push(entry)
      mergedByPid.set(entry.pid, entry)
      changed = true
    }
  }

  const ambiguousBirths = safeCapture.entries.filter(
    (entry) =>
      !ownershipByPid.has(entry.pid) &&
      !confirmedPids.has(entry.pid) &&
      !mergedByPid.has(entry.pid) &&
      (capturedPids.has(entry.parentPid) ||
        confirmedPids.has(entry.parentPid) ||
        capturedGroups.has(entry.processGroupId)),
  )
  if (ambiguousBirths.length > 0) {
    const error = new SmokeHarnessError('process-identity-unproved')
    error.reasonTag = 'capture-ambiguous-birth'
    error.ambiguousBirthEntries = ambiguousBirths
    throw error
  }
  if (confirmationEntries) {
    const coherent = []
    for (const entry of merged) {
      const confirmation = confirmationByPid.get(entry.pid)
      if (!confirmation) continue
      if (!sameProcessMetadata(confirmation, entry)) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      if (
        entry.ownershipTokenMatched === true &&
        confirmation.ownershipTokenMatched !== true
      ) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      coherent.push(entry)
    }
    return {
      entries: coherent,
      needsConfirmation: false,
      reconciledPids,
    }
  }
  return {
    entries: merged,
    needsConfirmation: vanishedAncestorPids.size > 0,
    reconciledPids,
  }
}

function systemProcessTableExecutable(platform) {
  if (platform === 'linux') return '/usr/bin/ps'
  if (platform === 'darwin') return '/bin/ps'
  throw new SmokeHarnessError('process-tracking-unsupported')
}

/**
 * Read the system process table through a fixed, bounded executable.
 *
 * @param {object} [dependencies] - Injected test dependencies.
 * @returns {Promise<object[]>} The reconciled process-table entries.
 * @throws {Error} On an unsafe executable, malformed output, or an unproved
 *   identity.
 */
export async function readProcessTable(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  const executable =
    dependencies.executable ?? systemProcessTableExecutable(platform)
  const inspectPath = dependencies.lstat ?? lstat
  const checkAccess = dependencies.access ?? access
  const execute = dependencies.execFile ?? execFileAsync
  const timeoutMs = dependencies.timeoutMs ?? PROCESS_TABLE_TIMEOUT_MS
  const ownershipToken = dependencies.ownershipToken
  const requiredPids = new Set(dependencies.requiredPids ?? [])
  const retainedRecords = dependencies.retainedRecords ?? []
  let safeProcessTableEntries = null
  if (
    [...requiredPids].some((pid) => !Number.isSafeInteger(pid) || pid <= 0) ||
    !Array.isArray(retainedRecords)
  ) {
    throw new SmokeHarnessError('process-identity-unproved')
  }

  try {
    const stats = await inspectPath(executable)
    if (!stats.isFile()) {
      throw new SmokeHarnessError('process-table-executable-invalid')
    }
    await checkAccess(executable, constants.X_OK)
  } catch (error) {
    if (error instanceof SmokeHarnessError) {
      throw tagSmokeError(error, 'process-table-identity')
    }
    throw new SmokeHarnessError('process-table-executable-invalid')
  }

  try {
    const commandOptions = {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      killSignal: 'SIGKILL',
      maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
    }
    const metadataFormat = 'pid=,ppid=,pgid=,uid=,lstart='
    const ownershipArgs =
      platform === 'darwin'
        ? ['-E', '-ww', '-axo', `${metadataFormat},command=`]
        : ['eww', 'axo', `${metadataFormat},command=`]
    const safeArgs = ['-ww', '-axo', `${metadataFormat},ucomm=`]
    const ownershipResult = await execute(
      executable,
      ownershipArgs,
      commandOptions,
    )
    const safeResult = await execute(executable, safeArgs, commandOptions)
    if (
      typeof ownershipResult.stdout !== 'string' ||
      typeof safeResult.stdout !== 'string'
    ) {
      throw new SmokeHarnessError('process-tracking-failed')
    }
    const ownershipEntries = parseOwnershipProcessTable(
      ownershipResult.stdout,
      ownershipToken,
    )
    const safeCapture = parseSafeProcessTable(safeResult.stdout)
    safeProcessTableEntries = safeCapture.entries
    const ancestryReparentCandidates = retainedAncestryReparentCandidates(
      ownershipEntries,
      safeCapture,
      requiredPids,
      retainedRecords,
      {
        identityKey: dependencies.identityKey,
        ownershipToken,
        platform,
      },
    )
    const durableTokenTransitionCandidates =
      retainedLinuxTokenTransitionCandidates(
        ownershipEntries,
        safeCapture,
        requiredPids,
        retainedRecords,
        platform,
      )
    let merged = mergeProcessCaptures(
      ownershipEntries,
      safeCapture,
      requiredPids,
      retainedRecords,
      null,
      new Set(ancestryReparentCandidates.keys()),
      new Set(durableTokenTransitionCandidates.keys()),
    )
    if (merged.reconciledPids.size > 0 || merged.needsConfirmation) {
      const confirmationResult = await execute(
        executable,
        ownershipArgs,
        commandOptions,
      )
      if (typeof confirmationResult.stdout !== 'string') {
        throw new SmokeHarnessError('process-tracking-failed')
      }
      const confirmationEntries = parseOwnershipProcessTable(
        confirmationResult.stdout,
        ownershipToken,
      )
      const confirmationByPid = indexProcessEntries(confirmationEntries)
      const effectiveConfirmationByPid = new Map(confirmationByPid)
      const safeByPid = indexProcessEntries(safeCapture.entries)
      const validatedSafeByPid = new Map(safeByPid)
      const validatedAncestryReparents = new Set()
      const validatedDurableTokenTransitions = new Set()
      for (const [candidates, validated] of [
        [ancestryReparentCandidates, validatedAncestryReparents],
        [durableTokenTransitionCandidates, validatedDurableTokenTransitions],
      ]) {
        for (const [pid, retained] of candidates) {
          const safeEntry = safeByPid.get(pid)
          const confirmation = confirmationByPid.get(pid)
          if (!safeEntry) continue
          if (
            confirmation &&
            (confirmation.userId !== retained.userId ||
              confirmation.startedAt !== retained.startedAt)
          ) {
            continue
          }
          const snapshot = await linuxOwnedProcessSnapshot(
            pid,
            confirmation?.userId,
            {
              readFile: dependencies.readFile,
              readProcessUserId: dependencies.readProcessUserId,
            },
          )
          if (
            snapshot === null ||
            snapshot.startIdentity !== retained.startIdentity ||
            snapshot.userId !== retained.userId
          ) {
            continue
          }
          const ancestryLifetime = retained.ownershipBasis === 'ancestry'
          if (
            ancestryLifetime &&
            (snapshot.processGroupId !== retained.processGroupId ||
              snapshot.processGroupId !== safeEntry.processGroupId)
          ) {
            continue
          }
          const relevantGroups = new Set([
            retained.processGroupId,
            safeEntry.processGroupId,
            snapshot.processGroupId,
          ])
          const unaccountedConfirmationMember = confirmationEntries.some(
            (entry) => {
              if (
                entry.pid === pid ||
                !relevantGroups.has(entry.processGroupId)
              ) {
                return false
              }
              const safeMember = safeByPid.get(entry.pid)
              return !safeMember || !sameProcessMetadata(entry, safeMember)
            },
          )
          if (unaccountedConfirmationMember) continue
          const exactConfirmation =
            confirmation &&
            confirmation.parentPid === snapshot.parentPid &&
            confirmation.processGroupId === snapshot.processGroupId
          const currentEntry = {
            ...safeEntry,
            command: snapshot.command,
            ...(!ancestryLifetime &&
            !(exactConfirmation && !unaccountedConfirmationMember)
              ? { groupOwnershipProved: false }
              : {}),
            parentPid: snapshot.parentPid,
            processGroupId: snapshot.processGroupId,
            userId: snapshot.userId,
            ownershipTokenMatched:
              exactConfirmation && confirmation.ownershipTokenMatched === true,
          }
          validated.add(pid)
          validatedSafeByPid.set(pid, currentEntry)
          effectiveConfirmationByPid.set(pid, currentEntry)
        }
      }
      if (
        [...ancestryReparentCandidates].some(
          ([pid]) => !validatedAncestryReparents.has(pid),
        ) ||
        [...durableTokenTransitionCandidates].some(
          ([pid]) => !validatedDurableTokenTransitions.has(pid),
        )
      ) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      const validatedSafeCapture = {
        ...safeCapture,
        entries: [...validatedSafeByPid.values()],
      }
      merged = mergeProcessCaptures(
        ownershipEntries,
        validatedSafeCapture,
        requiredPids,
        retainedRecords,
        [...effectiveConfirmationByPid.values()],
        validatedAncestryReparents,
        validatedDurableTokenTransitions,
      )
    }
    return merged.entries
  } catch (error) {
    if (
      error instanceof SmokeHarnessError &&
      error.code === 'process-identity-unproved' &&
      platform === 'linux' &&
      Array.isArray(error.ambiguousBirthEntries) &&
      safeProcessTableEntries !== null
    ) {
      error.processTableEntries = safeProcessTableEntries
      error.quarantinedProcesses = (
        await Promise.all(
          error.ambiguousBirthEntries.map((entry) =>
            quarantineProcessIdentity(entry, {
              platform,
              readFile: dependencies.readFile,
              readProcessUserId: dependencies.readProcessUserId,
            }),
          ),
        )
      ).filter(Boolean)
      error.retryableQuarantine = true
    }
    if (error instanceof SmokeHarnessError) throw error
    if (error?.killed === true && error?.signal === 'SIGKILL') {
      throw new SmokeHarnessError('process-table-timeout')
    }
    throw new SmokeHarnessError('process-tracking-failed')
  }
}

async function linuxProcessSnapshot(pid, dependencies = {}) {
  const loadFile = dependencies.readFile ?? readFile
  try {
    const stat = await loadFile(`/proc/${pid}/stat`, 'utf8')
    const open = stat.indexOf('(')
    const close = stat.lastIndexOf(')')
    const fields =
      open > 0 && close > open
        ? stat
            .slice(close + 1)
            .trim()
            .split(/\s+/)
        : []
    const statPid = Number(stat.slice(0, open).trim())
    const command = open > 0 && close > open ? stat.slice(open + 1, close) : ''
    const parentPid = Number(fields[1])
    const processGroupId = Number(fields[2])
    const startTicks = fields[19]
    if (
      !Number.isSafeInteger(statPid) ||
      statPid !== pid ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isSafeInteger(processGroupId) ||
      processGroupId < 0 ||
      command.length === 0 ||
      !startTicks ||
      !/^\d+$/.test(startTicks)
    ) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    return {
      command,
      parentPid,
      pid: statPid,
      processGroupId,
      startIdentity: `linux:${startTicks}`,
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null
    throw error
  }
}

/**
 * Read and validate one Linux process effective user ID.
 *
 * @param {number} pid
 * @param {object} [dependencies] - Injected test dependencies.
 * @returns {Promise<number>}
 * @throws {Error} On a missing, malformed, or unproved process identity.
 */
export async function linuxProcessEffectiveUserId(pid, dependencies = {}) {
  if (dependencies.readProcessUserId) {
    const userId = await dependencies.readProcessUserId(pid)
    if (!Number.isSafeInteger(userId) || userId < 0) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    return userId
  }
  try {
    const loadFile = dependencies.readFile ?? readFile
    const status = await loadFile(`/proc/${pid}/status`, 'utf8')
    const userId = Number(status.match(/^Uid:\s+\d+\s+(\d+)(?:\s|$)/m)?.[1])
    if (!Number.isSafeInteger(userId) || userId < 0) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    return userId
  } catch (error) {
    if (error instanceof SmokeHarnessError) throw error
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') throw error
    throw new SmokeHarnessError('process-identity-unproved')
  }
}

/**
 * Capture one stable Linux process snapshot with a proved owner.
 *
 * @param {number} pid
 * @param {number} fallbackUserId - The process-table user ID to fall back on.
 * @param {object} [dependencies] - Injected test dependencies.
 * @returns {Promise<object | null>} The stable snapshot, or null after the
 *   process exits.
 * @throws {Error} On a changing or unproved process identity.
 */
export async function linuxOwnedProcessSnapshot(
  pid,
  fallbackUserId,
  dependencies = {},
) {
  const before = await linuxProcessSnapshot(pid, dependencies)
  if (before === null) return null
  let userId
  if (dependencies.readProcessUserId || dependencies.readFile === undefined) {
    try {
      userId = await linuxProcessEffectiveUserId(pid, dependencies)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null
      throw error
    }
  } else {
    userId = fallbackUserId
  }
  const after = await linuxProcessSnapshot(pid, dependencies)
  if (after === null) return null
  if (before.startIdentity !== after.startIdentity) {
    throw new SmokeHarnessError('process-identity-unproved')
  }
  return { ...after, userId }
}

function processSnapshotMismatch(snapshot) {
  const error = new SmokeHarnessError('process-identity-unproved')
  error.retryableSnapshotMismatch = true
  error.processPid = snapshot.pid
  error.unprovedProcessIdentity = {
    parentPid: snapshot.parentPid,
    pid: snapshot.pid,
    processGroupId: snapshot.processGroupId,
    startIdentity: snapshot.startIdentity,
    userId: snapshot.userId,
  }
  return error
}

async function processStartIdentity(entry, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  if (platform === 'linux') {
    const snapshot = await linuxOwnedProcessSnapshot(
      entry.pid,
      entry.userId,
      dependencies,
    )
    if (snapshot === null) return null
    if (snapshot.userId !== entry.userId) {
      throw processSnapshotMismatch(snapshot)
    }
    if (snapshot.parentPid !== entry.parentPid) {
      throw processSnapshotMismatch(snapshot)
    }
    if (snapshot.processGroupId !== entry.processGroupId) {
      throw processSnapshotMismatch(snapshot)
    }
    if (snapshot.command !== entry.command) {
      if (dependencies.allowCommandTransition === true) {
        dependencies.onCommandTransition?.(snapshot.command)
      } else {
        throw processSnapshotMismatch(snapshot)
      }
    }
    return snapshot.startIdentity
  }
  return [platform, entry.startedAt].join(':')
}

function commandIdentity(command, identityKey) {
  return createHmac('sha256', identityKey).update(command, 'utf8').digest('hex')
}

/**
 * Bind one process-table entry to a durable ownership record.
 *
 * @param {object} entry - The inspected process-table entry.
 * @param {number} generation - The tracker generation.
 * @param {object} [dependencies] - Injected identity dependencies.
 * @returns {Promise<object | null>} The durable record, or null after the
 *   process exits.
 * @throws {Error} On unsupported or unproved ownership evidence.
 */
export async function processRecord(entry, generation, dependencies = {}) {
  let resolvedCommand = entry.command
  const startIdentity = await processStartIdentity(entry, {
    ...dependencies,
    onCommandTransition: (command) => {
      resolvedCommand = command
    },
  })
  if (startIdentity === null) return null
  const ownershipBasis =
    dependencies.ownershipBasis ??
    (entry.ownershipTokenMatched === true ? 'token' : 'ancestry')
  if (ownershipBasis !== 'token' && ownershipBasis !== 'ancestry') {
    throw new SmokeHarnessError('process-identity-unproved')
  }
  const identityKey =
    dependencies.identityKey ??
    dependencies.ownershipToken ??
    PROCESS_IDENTITY_FALLBACK_KEY
  return {
    pid: entry.pid,
    parentPid: entry.parentPid,
    processGroupId: entry.processGroupId,
    userId: entry.userId,
    startedAt: entry.startedAt,
    commandIdentity: commandIdentity(resolvedCommand, identityKey),
    ...(entry.groupOwnershipProved === false
      ? { groupOwnershipProved: false }
      : {}),
    ownershipBasis,
    startIdentity,
    generation,
    key: `${entry.pid}\0${startIdentity}\0${generation}`,
  }
}

async function classifyProcess(record, current, dependencies = {}) {
  if (!current) return 'dead'
  const platform = dependencies.platform ?? process.platform
  const durableLinuxCandidate =
    platform === 'linux' && record.startIdentity.startsWith('linux:')
  const candidate = await processRecord(current, record.generation, {
    allowCommandTransition: durableLinuxCandidate,
    identityKey: dependencies.identityKey,
    ownershipBasis: record.ownershipBasis,
    ownershipToken: dependencies.ownershipToken,
    platform: dependencies.platform,
    readFile: dependencies.readFile,
    readProcessUserId: dependencies.readProcessUserId,
  })
  if (
    candidate === null ||
    candidate.pid !== record.pid ||
    candidate.startIdentity !== record.startIdentity
  ) {
    return 'dead'
  }
  const durableLinuxIdentity =
    durableLinuxCandidate && candidate.userId === record.userId
  if (durableLinuxIdentity) return 'alive'
  if (record.ownershipBasis === 'token') {
    return current.ownershipTokenMatched === true ? 'alive' : 'unproved'
  }
  if (
    candidate.userId === record.userId &&
    candidate.parentPid === record.parentPid &&
    candidate.processGroupId === record.processGroupId &&
    candidate.commandIdentity === record.commandIdentity
  ) {
    return 'alive'
  }
  return 'unproved'
}

async function classifyObservedProcesses(observed, entries, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  const table =
    entries ??
    (await readProcessTable({
      identityKey: dependencies.identityKey,
      ownershipToken: dependencies.ownershipToken,
      platform,
      readFile: dependencies.readFile,
      readProcessUserId: dependencies.readProcessUserId,
      requiredPids: new Set([...observed.values()].map((record) => record.pid)),
      retainedRecords: [...observed.values()],
    }))
  const currentByPid = new Map(table.map((entry) => [entry.pid, entry]))
  const alive = []
  const unproved = []
  const states = new Map()
  for (const record of observed.values()) {
    const current = currentByPid.get(record.pid)
    const state = await classifyProcess(record, current, {
      identityKey: dependencies.identityKey,
      ownershipToken: dependencies.ownershipToken,
      platform,
      readFile: dependencies.readFile,
      readProcessUserId: dependencies.readProcessUserId,
    })
    states.set(record.key, state)
    if (state === 'alive') alive.push(record)
    if (state === 'unproved') unproved.push(record)
  }
  return { alive, currentByPid, states, table, unproved }
}

async function matchingProcesses(observed, entries, dependencies = {}) {
  const result = await classifyObservedProcesses(
    observed,
    entries,
    dependencies,
  )
  const ownedGroups = dependencies.ownedGroups
  if (!ownedGroups) {
    if (result.unproved.length > 0) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    return result.alive
  }
  const groupResult = await classifyOwnedGroups(
    ownedGroups,
    observed,
    result,
    dependencies,
  )
  const outsideOwnedGroups = unprovedOutsideOwnedGroups(result, groupResult)
  if (outsideOwnedGroups.length > 0 || groupResult.unproved.length > 0) {
    const unprovedGroup = groupResult.unproved[0]
    const groupEntries = unprovedGroup
      ? result.table.filter(
          (entry) => entry.processGroupId === unprovedGroup.processGroupId,
        )
      : []
    const implicatedRecord =
      outsideOwnedGroups[0] ??
      ownershipEvidenceRecords(
        new Map(),
        new Map(
          groupResult.unproved[0]
            ? [
                [
                  groupResult.unproved[0].processGroupId,
                  groupResult.unproved[0],
                ],
              ]
            : [],
        ),
      )[0]
    const error = new SmokeHarnessError('process-identity-unproved')
    if (outsideOwnedGroups.length === 0 && groupResult.unproved.length > 0) {
      error.quarantinedProcesses = (
        await Promise.all(
          groupEntries.map((entry) =>
            quarantineProcessIdentity(entry, dependencies),
          ),
        )
      ).filter(Boolean)
      error.retryableQuarantine = true
    }
    if (implicatedRecord) {
      error.retryableSnapshotMismatch = true
      error.processPid = implicatedRecord.pid
    }
    throw error
  }
  return result.alive
}

async function quarantineProcessIdentity(entry, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  if (platform === 'linux') {
    const snapshot = await linuxOwnedProcessSnapshot(
      entry.pid,
      entry.userId,
      dependencies,
    )
    if (snapshot === null) return null
    return {
      parentPid: snapshot.parentPid,
      pid: snapshot.pid,
      processGroupId: snapshot.processGroupId,
      startIdentity: snapshot.startIdentity,
      userId: snapshot.userId,
    }
  }
  return processRecord(entry, 0, {
    identityKey: dependencies.identityKey,
    ownershipBasis: 'ancestry',
    ownershipToken: dependencies.ownershipToken,
    platform,
    readFile: dependencies.readFile,
    readProcessUserId: dependencies.readProcessUserId,
  })
}

function quarantineKey(record) {
  return `${record.pid}\0${record.startIdentity}\0${record.userId}`
}

function quarantineHasOwnership(record, observed, platform) {
  return [...observed.values()].some((owned) => {
    if (
      owned.pid !== record.pid ||
      owned.startIdentity !== record.startIdentity ||
      owned.userId !== record.userId
    ) {
      return false
    }
    if (platform === 'linux') return true
    return (
      owned.parentPid === record.parentPid &&
      owned.processGroupId === record.processGroupId &&
      owned.commandIdentity === record.commandIdentity
    )
  })
}

async function quarantineIdentityState(record, entries, dependencies = {}) {
  const current = entries.find((entry) => entry.pid === record.pid)
  const platform = dependencies.platform ?? process.platform
  if (platform === 'linux') {
    const snapshot = await linuxOwnedProcessSnapshot(
      record.pid,
      current?.userId ?? record.userId,
      dependencies,
    )
    if (snapshot === null) return 'dead'
    if (snapshot.startIdentity !== record.startIdentity) return 'dead'
    return snapshot.userId === record.userId ? 'alive' : 'unproved'
  }
  if (!current) return 'dead'
  const candidate = await processRecord(current, 0, {
    identityKey: dependencies.identityKey,
    ownershipBasis: 'ancestry',
    ownershipToken: dependencies.ownershipToken,
    platform,
    readFile: dependencies.readFile,
    readProcessUserId: dependencies.readProcessUserId,
  })
  return candidate !== null && candidate.startIdentity === record.startIdentity
    ? 'alive'
    : 'dead'
}

async function unresolvedQuarantineProcessGroups(
  quarantinedProcesses,
  observed,
  entries,
  dependencies = {},
) {
  if (!Array.isArray(quarantinedProcesses)) {
    return { processGroupIds: new Set(), records: [] }
  }
  const platform = dependencies.platform ?? process.platform
  const processGroupIds = new Set()
  const records = []
  for (const record of quarantinedProcesses) {
    if (quarantineHasOwnership(record, observed, platform)) continue
    if (platform === 'linux') {
      const current = entries.find((entry) => entry.pid === record.pid)
      const snapshot = await linuxOwnedProcessSnapshot(
        record.pid,
        current?.userId ?? record.userId,
        dependencies,
      )
      if (
        snapshot === null ||
        snapshot.startIdentity !== record.startIdentity
      ) {
        continue
      }
      if (snapshot.userId !== record.userId) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      processGroupIds.add(record.processGroupId)
      processGroupIds.add(snapshot.processGroupId)
      records.push(record)
      continue
    }
    const state = await quarantineIdentityState(record, entries, dependencies)
    if (state === 'dead') continue
    if (state !== 'alive') {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    const current = entries.find((entry) => entry.pid === record.pid)
    processGroupIds.add(record.processGroupId)
    if (current) processGroupIds.add(current.processGroupId)
    records.push(record)
  }
  return { processGroupIds, records }
}

function cloneOwnedGroups(groups) {
  return new Map(
    [...groups].map(([processGroupId, group]) => [
      processGroupId,
      {
        ...group,
        anchorRecords: [...(group.anchorRecords ?? [])],
        coordinateRecords: [...(group.coordinateRecords ?? [])],
        memberKeys: [...group.memberKeys],
      },
    ]),
  )
}

function ownershipEvidenceRecords(observed, groups) {
  const records = [...observed.values()]
  for (const group of groups.values()) {
    records.push(
      group.leaderRecord,
      ...(group.anchorRecords ?? []),
      ...(group.coordinateRecords ?? []),
      ...group.memberKeys.map((key) => observed.get(key)),
    )
  }
  return records.filter(
    (record, index, allRecords) =>
      record &&
      allRecords.findIndex((candidate) => candidate?.key === record.key) ===
        index,
  )
}

function entriesAddNoOwnershipEvidence(
  entries,
  observed,
  groups,
  identityKey,
  mismatchedPid,
) {
  const retained = ownershipEvidenceRecords(observed, groups)
  const retainedPids = new Set(retained.map((record) => record.pid))
  const retainedGroups = new Set([
    ...groups.keys(),
    ...retained.map((record) => record.processGroupId),
  ])
  const entriesByPid = new Map(entries.map((entry) => [entry.pid, entry]))
  const relevantPids = new Set(
    entries
      .filter(
        (entry) =>
          entry.ownershipTokenMatched === true ||
          retainedPids.has(entry.pid) ||
          retainedGroups.has(entry.processGroupId),
      )
      .map((entry) => entry.pid),
  )
  let changed = true
  while (changed) {
    changed = false
    for (const entry of entries) {
      const parent = entriesByPid.get(entry.parentPid)
      if (
        relevantPids.has(entry.pid) ||
        !relevantPids.has(entry.parentPid) ||
        parent?.userId !== entry.userId
      ) {
        continue
      }
      relevantPids.add(entry.pid)
      changed = true
    }
  }
  if (!relevantPids.has(mismatchedPid)) return false
  return entries
    .filter((entry) => relevantPids.has(entry.pid))
    .every((entry) =>
      retained.some(
        (record) =>
          record.pid === entry.pid &&
          record.parentPid === entry.parentPid &&
          record.processGroupId === entry.processGroupId &&
          record.userId === entry.userId &&
          record.startedAt === entry.startedAt &&
          record.commandIdentity ===
            commandIdentity(entry.command, identityKey),
      ),
    )
}

function snapshotMismatchTouchesOwnership(identity, entries, observed, groups) {
  const current = entries.find((entry) => entry.pid === identity?.pid)
  if (!current || current.userId !== identity.userId) return false
  if (current.ownershipTokenMatched === true) return true

  const evidence = ownershipEvidenceRecords(observed, groups)
  const touchesEvidence = (candidate) =>
    evidence.some(
      (record) =>
        record.userId === identity.userId &&
        (record.pid === candidate.parentPid ||
          record.processGroupId === candidate.processGroupId),
    )
  return touchesEvidence(current) || touchesEvidence(identity)
}

function ownershipStateMatches(observed, groups, observedBefore, groupsBefore) {
  const currentRecords = ownershipEvidenceRecords(observed, groups)
  const priorRecords = ownershipEvidenceRecords(observedBefore, groupsBefore)
  if (
    observed.size !== observedBefore.size ||
    groups.size !== groupsBefore.size ||
    currentRecords.length !== priorRecords.length
  ) {
    return false
  }
  return currentRecords.every((record, index) => {
    const prior = priorRecords[index]
    return (
      prior &&
      Object.keys(record).length === Object.keys(prior).length &&
      Object.entries(record).every(([key, value]) => prior[key] === value)
    )
  })
}

async function registerOwnedGroup(
  ownedGroups,
  observed,
  record,
  entries,
  dependencies,
  nextGeneration,
) {
  if (record.groupOwnershipProved === false) return
  const processGroupId = record.processGroupId
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new SmokeHarnessError('process-identity-unproved')
  }
  let group = ownedGroups.get(processGroupId)
  if (!group) {
    const leaderEntry = entries.find((entry) => entry.pid === processGroupId)
    let leaderRecord = null
    if (leaderEntry) {
      if (record.pid === leaderEntry.pid) {
        leaderRecord = record
      } else {
        const candidate = await processRecord(leaderEntry, nextGeneration(), {
          allowCommandTransition: dependencies.platform === 'linux',
          identityKey: dependencies.identityKey,
          ownershipBasis:
            leaderEntry.ownershipTokenMatched === true ? 'token' : 'ancestry',
          ownershipToken: dependencies.ownershipToken,
          platform: dependencies.platform,
          readFile: dependencies.readFile,
          readProcessUserId: dependencies.readProcessUserId,
        })
        const existing =
          candidate &&
          [...observed.values()].find(
            (record) =>
              record.pid === candidate.pid &&
              record.startIdentity === candidate.startIdentity,
          )
        leaderRecord =
          existing && existing.processGroupId !== candidate.processGroupId
            ? {
                ...candidate,
                key: `${candidate.key}\0leader`,
                ownershipBasis: existing.ownershipBasis,
              }
            : existing || candidate
      }
    }
    group = {
      anchorRecords: [],
      coordinateRecords: [],
      processGroupId,
      leaderRecord,
      memberKeys: [],
    }
    ownedGroups.set(processGroupId, group)
  }
  if (record.ownershipBasis === 'token') {
    group.anchorRecords ??= []
    group.coordinateRecords ??= []
    const anchorIndex = group.anchorRecords.findIndex(
      (anchor) =>
        anchor.pid === record.pid &&
        anchor.startIdentity === record.startIdentity,
    )
    if (anchorIndex >= 0) {
      group.anchorRecords[anchorIndex] = record
    } else {
      group.anchorRecords.push(record)
    }
    const coordinateRecord = {
      ...record,
      coordinateFallback: true,
      key: `${record.key}\0coordinate`,
      ownershipBasis: 'ancestry',
    }
    const coordinateIndex = group.coordinateRecords.findIndex(
      (coordinate) =>
        coordinate.pid === record.pid &&
        coordinate.startIdentity === record.startIdentity,
    )
    if (coordinateIndex >= 0) {
      group.coordinateRecords[coordinateIndex] = coordinateRecord
    } else {
      group.coordinateRecords.push(coordinateRecord)
    }
    if (record.pid === processGroupId) group.leaderRecord = record
  }
  if (
    record.ownershipBasis === 'ancestry' &&
    !group.memberKeys.includes(record.key)
  ) {
    group.memberKeys.push(record.key)
  }
}

async function stageOwnedSnapshot(
  observed,
  ownedGroups,
  entries,
  dependencies = {},
) {
  const platform = dependencies.platform ?? process.platform
  const identityKey =
    dependencies.identityKey ??
    dependencies.ownershipToken ??
    PROCESS_IDENTITY_FALLBACK_KEY
  let generation = Math.max(
    0,
    ...[...observed.values()].map((record) => record.generation),
  )
  const nextGeneration = () => (generation += 1)
  const initial = await classifyObservedProcesses(observed, entries, {
    ...dependencies,
    identityKey,
    platform,
  })
  const active = [...initial.alive]

  const adopt = async (entry, ownershipBasis) => {
    const retainedSamePid = [...observed.values()].filter(
      (record) => record.pid === entry.pid,
    )
    let candidate
    try {
      candidate = await processRecord(entry, nextGeneration(), {
        allowCommandTransition:
          platform === 'linux' &&
          (retainedSamePid.length > 0 || ownershipBasis === 'ancestry'),
        identityKey,
        ownershipBasis,
        ownershipToken: dependencies.ownershipToken,
        platform,
        readFile: dependencies.readFile,
        readProcessUserId: dependencies.readProcessUserId,
      })
    } catch (error) {
      if (
        platform === 'linux' &&
        ownershipBasis === 'token' &&
        retainedSamePid.length === 0 &&
        error?.retryableSnapshotMismatch === true &&
        error?.unprovedProcessIdentity
      ) {
        error.retryableQuarantine = true
        error.quarantinedProcesses = [error.unprovedProcessIdentity]
      }
      throw error
    }
    if (!candidate) return null
    const existing = retainedSamePid.find(
      (record) =>
        record.pid === candidate.pid &&
        record.startIdentity === candidate.startIdentity,
    )
    if (retainedSamePid.length > 0 && !existing) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    if (existing) {
      return {
        active: initial.states.get(existing.key) === 'alive',
        added: false,
        proof: candidate,
        record: existing,
      }
    }
    observed.set(candidate.key, candidate)
    active.push(candidate)
    return {
      active: true,
      added: true,
      proof: candidate,
      record: candidate,
    }
  }

  for (const entry of entries) {
    if (entry.ownershipTokenMatched !== true) continue
    const adoption = await adopt(entry, 'token')
    if (
      !adoption &&
      entries.some((candidate) => candidate.parentPid === entry.pid)
    ) {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    if (adoption?.active) {
      await registerOwnedGroup(
        ownedGroups,
        observed,
        adoption.proof,
        entries,
        { ...dependencies, identityKey, platform },
        nextGeneration,
      )
    }
  }

  const currentByPid = new Map(entries.map((entry) => [entry.pid, entry]))
  const knownParents = new Map(
    active
      .map((record) => currentByPid.get(record.pid))
      .filter((entry) => entry)
      .map((entry) => [entry.pid, entry.userId]),
  )
  const discoveredPids = new Set(knownParents.keys())
  const discoverDescendants = async () => {
    let addedAny = false
    let changed = true
    while (changed) {
      changed = false
      for (const entry of entries) {
        if (
          !knownParents.has(entry.parentPid) ||
          discoveredPids.has(entry.pid)
        ) {
          continue
        }
        if (
          entry.ownershipTokenMatched !== true &&
          entry.userId !== knownParents.get(entry.parentPid)
        ) {
          throw new SmokeHarnessError('process-ownership-user-mismatch')
        }
        const ownershipBasis =
          entry.ownershipTokenMatched === true ? 'token' : 'ancestry'
        const adoption = await adopt(entry, ownershipBasis)
        if (
          !adoption &&
          entries.some((candidate) => candidate.parentPid === entry.pid)
        ) {
          throw new SmokeHarnessError('process-identity-unproved')
        }
        discoveredPids.add(entry.pid)
        if (!adoption?.active) continue
        if (adoption.added && ownershipBasis === 'ancestry') {
          await registerOwnedGroup(
            ownedGroups,
            observed,
            adoption.record,
            entries,
            { ...dependencies, identityKey, platform },
            nextGeneration,
          )
        }
        knownParents.set(entry.pid, entry.userId)
        addedAny = true
        changed = true
      }
    }
    return addedAny
  }

  await discoverDescendants()

  if (platform === 'linux') {
    let expanded = true
    while (expanded) {
      expanded = false
      const processResult = await classifyObservedProcesses(observed, entries, {
        ...dependencies,
        identityKey,
        platform,
      })
      const groupResult = await classifyOwnedGroups(
        ownedGroups,
        observed,
        processResult,
        { ...dependencies, identityKey, platform },
      )
      for (const group of groupResult.alive) {
        const retainedUsers = new Set(
          ownershipEvidenceRecords(
            new Map(),
            new Map([[group.processGroupId, group]]),
          ).map((record) => record.userId),
        )
        for (const entry of entries) {
          if (
            entry.processGroupId !== group.processGroupId ||
            !retainedUsers.has(entry.userId) ||
            discoveredPids.has(entry.pid)
          ) {
            continue
          }
          const adoption = await adopt(entry, 'ancestry')
          discoveredPids.add(entry.pid)
          if (!adoption?.active) continue
          if (adoption.added) {
            await registerOwnedGroup(
              ownedGroups,
              observed,
              adoption.record,
              entries,
              { ...dependencies, identityKey, platform },
              nextGeneration,
            )
          }
          knownParents.set(entry.pid, entry.userId)
          expanded = true
        }
      }
      if (expanded) await discoverDescendants()
    }
  }
  return generation
}

async function adoptOwnedSnapshot(
  observed,
  ownedGroups,
  entries,
  dependencies = {},
) {
  const stagedObserved = new Map(observed)
  const stagedGroups = cloneOwnedGroups(ownedGroups)
  const generation = await stageOwnedSnapshot(
    stagedObserved,
    stagedGroups,
    entries,
    dependencies,
  )
  await matchingProcesses(stagedObserved, entries, {
    ...dependencies,
    ownedGroups: stagedGroups,
  })
  observed.clear()
  for (const [key, record] of stagedObserved) observed.set(key, record)
  ownedGroups.clear()
  for (const [processGroupId, group] of stagedGroups) {
    ownedGroups.set(processGroupId, group)
  }
  return generation
}

/**
 * Start bounded ownership tracking for one launched process tree.
 *
 * @param {number} rootPid
 * @param {object} [dependencies] - Injected tracker dependencies, such as the
 *   `ownershipToken`.
 * @returns {object} Readiness, signaling, stopping, and snapshot controls.
 * @throws {Error} On invalid or unproved root-process ownership.
 */
export function startProcessTracker(rootPid, dependencies = {}) {
  const ownershipToken = dependencies.ownershipToken
  const identityKey =
    dependencies.identityKey ?? ownershipToken ?? PROCESS_IDENTITY_FALLBACK_KEY
  const platform = dependencies.platform ?? process.platform
  const expectedRootOwner = dependencies.expectedRootOwner
  const pollIntervalMs = dependencies.pollIntervalMs ?? 100
  const observed = new Map()
  let rootRegistered = false
  const loadProcessTable =
    dependencies.readProcessTable ??
    (() =>
      readProcessTable({
        identityKey,
        ownershipToken,
        platform,
        readFile: dependencies.readFile,
        readProcessUserId: dependencies.readProcessUserId,
        requiredPids: new Set([
          ...(rootRegistered ? [] : [rootPid]),
          ...[...observed.values()].map((record) => record.pid),
        ]),
        retainedRecords: [...observed.values()],
      }))
  const ownedGroups = new Map()
  const unresolvedQuarantines = new Map()
  let unresolvedQuarantineError = null
  let pending = Promise.resolve()
  let trackerFailed = false
  let trackerError = null
  let timer = null
  let generation = 0
  let stableMarkerlessRoot = null
  let pendingTokenRootIdentity = null
  const rootRegistrationDeadline =
    Date.now() + (dependencies.rootRegistrationTimeoutMs ?? 1_000)
  const identityRetryTimeoutMs =
    dependencies.identityRetryTimeoutMs ?? PROCESS_IDENTITY_RETRY_TIMEOUT_MS
  const identityRetryDelayMs =
    dependencies.identityRetryDelayMs ?? PROCESS_IDENTITY_RETRY_DELAY_MS
  let currentAttemptEntries = null
  let currentAttemptReasonTag = 'tracker-load-identity'
  let stopped = false

  const enqueue = (operation) => {
    const result = pending.then(operation)
    pending = result.catch(() => undefined)
    return result
  }

  const sampleOnce = async () => {
    currentAttemptReasonTag = 'tracker-load-identity'
    let entries
    try {
      entries = await loadProcessTable()
    } catch (error) {
      if (Array.isArray(error?.processTableEntries)) {
        currentAttemptEntries = error.processTableEntries
      }
      throw error
    }
    currentAttemptEntries = entries
    const currentByPid = new Map(entries.map((entry) => [entry.pid, entry]))
    let registeredRootThisSample = false
    if (rootRegistered) {
      // Refresh identity because a token-owned process may exec or move groups
      // between samples. Record its exact coordinates before validating the
      // previously recorded group.
      currentAttemptReasonTag = 'tracker-refresh-identity'
      generation = await adoptOwnedSnapshot(observed, ownedGroups, entries, {
        identityKey,
        ownershipToken,
        platform,
        readFile: dependencies.readFile,
        readProcessUserId: dependencies.readProcessUserId,
      })
    }
    currentAttemptReasonTag = 'tracker-match-identity'
    await matchingProcesses(observed, entries, {
      identityKey,
      ownedGroups,
      ownershipToken,
      platform,
      readFile: dependencies.readFile,
      readProcessUserId: dependencies.readProcessUserId,
    })
    if (!rootRegistered) {
      currentAttemptReasonTag = 'tracker-register-root-identity'
      const root = currentByPid.get(rootPid)
      if (!root) {
        if (Date.now() < rootRegistrationDeadline) return false
        throw new SmokeHarnessError('process-tracking-failed')
      }
      let rootBasis = 'token'
      if (pendingTokenRootIdentity && root.ownershipTokenMatched !== true) {
        const identityState = await quarantineIdentityState(
          pendingTokenRootIdentity,
          entries,
          {
            identityKey,
            ownershipToken,
            platform,
            readFile: dependencies.readFile,
            readProcessUserId: dependencies.readProcessUserId,
          },
        )
        if (identityState !== 'dead' && Date.now() < rootRegistrationDeadline) {
          return false
        }
        throw new SmokeHarnessError('process-identity-unproved')
      }
      if (ownershipToken && root.ownershipTokenMatched !== true) {
        const directRoot =
          expectedRootOwner &&
          root.parentPid === expectedRootOwner.parentPid &&
          root.processGroupId === expectedRootOwner.processGroupId &&
          root.userId === expectedRootOwner.userId
        if (!directRoot) {
          if (Date.now() < rootRegistrationDeadline) return false
          throw new SmokeHarnessError('process-ownership-marker-missing')
        }
        const candidate = await processRecord(root, generation + 1, {
          identityKey,
          ownershipBasis: 'ancestry',
          platform,
          readFile: dependencies.readFile,
          readProcessUserId: dependencies.readProcessUserId,
        })
        if (!candidate) {
          if (Date.now() < rootRegistrationDeadline) return false
          throw new SmokeHarnessError('process-tracking-failed')
        }
        const stable =
          stableMarkerlessRoot &&
          stableMarkerlessRoot.pid === candidate.pid &&
          stableMarkerlessRoot.startIdentity === candidate.startIdentity &&
          stableMarkerlessRoot.userId === candidate.userId &&
          stableMarkerlessRoot.parentPid === candidate.parentPid &&
          stableMarkerlessRoot.processGroupId === candidate.processGroupId &&
          stableMarkerlessRoot.commandIdentity === candidate.commandIdentity
        if (!stable) {
          stableMarkerlessRoot = candidate
          if (Date.now() < rootRegistrationDeadline) return false
          throw new SmokeHarnessError('process-ownership-marker-missing')
        }
        rootBasis = 'ancestry'
      }
      let record
      const rootGeneration = generation + 1
      try {
        record = await processRecord(root, rootGeneration, {
          identityKey,
          ownershipBasis: rootBasis,
          ownershipToken,
          platform,
          readFile: dependencies.readFile,
          readProcessUserId: dependencies.readProcessUserId,
        })
      } catch (error) {
        const identity = error?.unprovedProcessIdentity
        if (
          platform !== 'linux' ||
          rootBasis !== 'token' ||
          error?.retryableSnapshotMismatch !== true ||
          !identity
        ) {
          throw error
        }
        if (
          pendingTokenRootIdentity &&
          quarantineKey(pendingTokenRootIdentity) !== quarantineKey(identity)
        ) {
          throw new SmokeHarnessError('process-identity-unproved')
        }
        pendingTokenRootIdentity = identity
        if (Date.now() < rootRegistrationDeadline) return false
        throw new SmokeHarnessError('process-identity-unproved')
      }
      if (!record) throw new SmokeHarnessError('process-tracking-failed')
      if (
        pendingTokenRootIdentity &&
        quarantineKey(pendingTokenRootIdentity) !== quarantineKey(record)
      ) {
        throw new SmokeHarnessError('process-identity-unproved')
      }
      generation = rootGeneration
      observed.set(record.key, record)
      pendingTokenRootIdentity = null
      currentAttemptReasonTag = 'tracker-register-group-identity'
      await registerOwnedGroup(
        ownedGroups,
        observed,
        record,
        entries,
        {
          identityKey,
          ownershipToken,
          platform,
          readFile: dependencies.readFile,
          readProcessUserId: dependencies.readProcessUserId,
        },
        () => ++generation,
      )
      rootRegistered = true
      registeredRootThisSample = true
    }
    if (registeredRootThisSample) {
      currentAttemptReasonTag = 'tracker-post-register-identity'
      generation = await adoptOwnedSnapshot(observed, ownedGroups, entries, {
        identityKey,
        ownershipToken,
        platform,
        readFile: dependencies.readFile,
        readProcessUserId: dependencies.readProcessUserId,
      })
    }
    return true
  }

  const sample = async () => {
    const deadline = Date.now() + identityRetryTimeoutMs
    const quarantined = new Map(unresolvedQuarantines)
    let quarantineError = unresolvedQuarantineError
    while (true) {
      const observedBefore = new Map(observed)
      const groupsBefore = cloneOwnedGroups(ownedGroups)
      const generationBefore = generation
      const rootRegisteredBefore = rootRegistered
      const stableMarkerlessRootBefore = stableMarkerlessRoot
      const pendingTokenRootIdentityBefore = pendingTokenRootIdentity
      currentAttemptEntries = null
      try {
        const result = await sampleOnce()
        let unresolvedQuarantine = false
        for (const [key, record] of quarantined) {
          if (quarantineHasOwnership(record, observed, platform)) {
            quarantined.delete(key)
            unresolvedQuarantines.delete(key)
            continue
          }
          const identityState = await quarantineIdentityState(
            record,
            currentAttemptEntries ?? [],
            {
              identityKey,
              ownershipToken,
              platform,
              readFile: dependencies.readFile,
              readProcessUserId: dependencies.readProcessUserId,
            },
          )
          if (identityState === 'dead') {
            quarantined.delete(key)
            unresolvedQuarantines.delete(key)
            continue
          }
          unresolvedQuarantine = true
        }
        if (!unresolvedQuarantine) {
          unresolvedQuarantineError = null
          return result
        }
        observed.clear()
        for (const [key, record] of observedBefore) observed.set(key, record)
        ownedGroups.clear()
        for (const [processGroupId, group] of groupsBefore) {
          ownedGroups.set(processGroupId, group)
        }
        generation = generationBefore
        rootRegistered = rootRegisteredBefore
        stableMarkerlessRoot = stableMarkerlessRootBefore
        pendingTokenRootIdentity = pendingTokenRootIdentityBefore
        if (Date.now() >= deadline) {
          const error =
            quarantineError ??
            new SmokeHarnessError('process-identity-unproved')
          if (error.reasonTag === 'capture-ambiguous-birth') {
            error.reasonTag = 'capture-ambiguous-birth-persistent'
          }
          throw tagSmokeError(error, 'tracker-sample-identity')
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, identityRetryDelayMs),
        )
        continue
      } catch (error) {
        tagSmokeError(error, currentAttemptReasonTag)
        tagSmokeError(error, 'tracker-sample-identity')
        const stateUnchanged = ownershipStateMatches(
          observed,
          ownedGroups,
          observedBefore,
          groupsBefore,
        )
        const registeredRootDuringAttempt =
          !rootRegisteredBefore && rootRegistered
        const retryableOwnedSnapshotMismatch =
          rootRegisteredBefore &&
          error instanceof SmokeHarnessError &&
          error.code === 'process-identity-unproved' &&
          error.retryableSnapshotMismatch === true &&
          error.unprovedProcessIdentity &&
          currentAttemptEntries !== null &&
          snapshotMismatchTouchesOwnership(
            error.unprovedProcessIdentity,
            currentAttemptEntries,
            observedBefore,
            groupsBefore,
          )
        if (registeredRootDuringAttempt || retryableOwnedSnapshotMismatch) {
          error.retryableQuarantine = true
          error.quarantinedProcesses = [error.unprovedProcessIdentity]
        }
        const evidenceUnchanged =
          currentAttemptEntries !== null &&
          Number.isSafeInteger(error?.processPid) &&
          entriesAddNoOwnershipEvidence(
            currentAttemptEntries,
            observedBefore,
            groupsBefore,
            identityKey,
            error.processPid,
          )
        const retryable =
          error instanceof SmokeHarnessError &&
          error.code === 'process-identity-unproved' &&
          error.retryableSnapshotMismatch === true &&
          Number.isSafeInteger(error.processPid) &&
          rootRegisteredBefore &&
          currentAttemptEntries !== null &&
          stateUnchanged &&
          evidenceUnchanged
        const retryableQuarantine =
          error instanceof SmokeHarnessError &&
          error.code === 'process-identity-unproved' &&
          error.retryableQuarantine === true &&
          Array.isArray(error.quarantinedProcesses) &&
          currentAttemptEntries !== null &&
          (stateUnchanged || registeredRootDuringAttempt)
        if (retryableQuarantine) {
          quarantineError = error
          unresolvedQuarantineError = error
          for (const record of error.quarantinedProcesses) {
            const key = quarantineKey(record)
            quarantined.set(key, record)
            unresolvedQuarantines.set(key, record)
          }
        }
        if ((!retryable && !retryableQuarantine) || Date.now() >= deadline) {
          throw error
        }
        if (!registeredRootDuringAttempt) {
          generation = generationBefore
          rootRegistered = rootRegisteredBefore
          stableMarkerlessRoot = stableMarkerlessRootBefore
          pendingTokenRootIdentity = pendingTokenRootIdentityBefore
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, identityRetryDelayMs),
        )
      }
    }
  }

  const schedule = () => {
    timer = setTimeout(() => {
      void enqueue(sample)
        .catch((error) => {
          trackerFailed = true
          trackerError ??= error
        })
        .finally(() => {
          if (!stopped) schedule()
        })
    }, pollIntervalMs)
    timer.unref()
  }

  const ready = (async () => {
    while (!(await enqueue(sample))) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    }
  })()
    .then(() => {
      if (!stopped) schedule()
    })
    .catch((error) => {
      trackerFailed = true
      trackerError ??= error
      throw error
    })

  return {
    ready,
    async adoptAndSignal(signal, signalDependencies = {}) {
      if (stopped) {
        throw new SmokeHarnessError('process-tracker-stopped')
      }
      const operation = enqueue(async () => {
        if (trackerFailed) {
          const entries = await loadProcessTable()
          generation = await adoptOwnedSnapshot(
            observed,
            ownedGroups,
            entries,
            {
              identityKey,
              ownershipToken,
              platform,
              readFile: dependencies.readFile,
              readProcessUserId: dependencies.readProcessUserId,
            },
          )
        } else {
          await sample()
        }
        await signalTrackedProcesses(observed, signal, {
          ...signalDependencies,
          identityKey,
          ownedGroups,
          ownershipToken,
          platform,
          readFile: dependencies.readFile,
          readProcessUserId: dependencies.readProcessUserId,
          readProcessTable: loadProcessTable,
          quarantinedProcesses: [...unresolvedQuarantines.values()],
        })
      })
      try {
        await operation
      } catch (error) {
        trackerFailed = true
        trackerError ??= error
        throw error
      }
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await ready.catch(() => undefined)
      await pending
      await enqueue(sample).catch((error) => {
        trackerFailed = true
        trackerError ??= error
      })
      if (trackerFailed) {
        if (trackerError instanceof SmokeHarnessError) throw trackerError
        throw new SmokeHarnessError('process-tracking-failed')
      }
      return new Map(observed)
    },
    groupSnapshot: () => cloneOwnedGroups(ownedGroups),
    quarantineSnapshot: () => [...unresolvedQuarantines.values()],
    snapshot: () => new Map(observed),
  }
}

async function classifyOwnedGroup(
  group,
  observed,
  processResult,
  dependencies,
) {
  const groupEntries = processResult.table.filter(
    (entry) => entry.processGroupId === group.processGroupId,
  )
  if (groupEntries.length === 0) return 'dead'

  const anchors = [
    group.leaderRecord,
    ...(group.anchorRecords ?? []),
    ...(group.coordinateRecords ?? []),
    ...group.memberKeys.map((key) => observed.get(key)),
  ].filter(
    (record, index, records) =>
      record &&
      records.findIndex((candidate) => candidate?.key === record.key) === index,
  )
  const anchorStates = new Map()
  for (const record of anchors) {
    const current = processResult.currentByPid.get(record.pid)
    if (!current) {
      anchorStates.set(record.key, 'dead')
      continue
    }
    const candidate = await processRecord(current, record.generation, {
      allowCommandTransition:
        dependencies.platform === 'linux' &&
        record.startIdentity.startsWith('linux:'),
      identityKey: dependencies.identityKey,
      ownershipBasis: record.ownershipBasis,
      ownershipToken: dependencies.ownershipToken,
      platform: dependencies.platform,
      readFile: dependencies.readFile,
      readProcessUserId: dependencies.readProcessUserId,
    })
    if (
      !candidate ||
      candidate.pid !== record.pid ||
      candidate.startIdentity !== record.startIdentity
    ) {
      anchorStates.set(record.key, 'dead')
      continue
    }
    const durableLinuxIdentity =
      dependencies.platform === 'linux' &&
      record.startIdentity.startsWith('linux:') &&
      candidate.userId === record.userId
    const markerMatches =
      record.ownershipBasis !== 'token' ||
      current.ownershipTokenMatched === true ||
      durableLinuxIdentity
    const parentMatches =
      durableLinuxIdentity ||
      record.ownershipBasis === 'token' ||
      (dependencies.platform === 'linux' &&
        record.startIdentity.startsWith('linux:')) ||
      candidate.parentPid === record.parentPid
    const userMatches = candidate.userId === record.userId
    const groupMatches = candidate.processGroupId === record.processGroupId
    const commandMatches =
      durableLinuxIdentity ||
      candidate.commandIdentity === record.commandIdentity
    const state =
      markerMatches &&
      parentMatches &&
      userMatches &&
      groupMatches &&
      commandMatches
        ? 'alive'
        : 'unproved'
    anchorStates.set(record.key, state)
  }
  const hasExactAnchor = anchors.some(
    (record) =>
      anchorStates.get(record.key) === 'alive' &&
      processResult.currentByPid.get(record.pid)?.processGroupId ===
        group.processGroupId,
  )
  const unprovedAnchor = anchors.find((record) => {
    if (anchorStates.get(record.key) !== 'unproved') return false
    const current = processResult.currentByPid.get(record.pid)
    if (
      current &&
      current.processGroupId !== group.processGroupId &&
      dependencies.platform === 'linux' &&
      record.startIdentity.startsWith('linux:')
    ) {
      return false
    }
    const counterpart = anchors.find(
      (candidate) =>
        candidate.pid === record.pid &&
        candidate.startIdentity === record.startIdentity &&
        anchorStates.get(candidate.key) === 'alive' &&
        ((record.coordinateFallback === true &&
          candidate.ownershipBasis === 'token') ||
          (record.ownershipBasis === 'token' &&
            candidate.coordinateFallback === true)),
    )
    return !counterpart
  })
  if (unprovedAnchor) return 'unproved'

  const leaderState = group.leaderRecord
    ? anchorStates.get(group.leaderRecord.key)
    : 'dead'
  if (
    leaderState === 'dead' &&
    processResult.currentByPid.has(group.processGroupId)
  ) {
    return hasExactAnchor ? 'unproved' : 'dead'
  }
  if (hasExactAnchor) return 'alive'
  return 'unproved'
}

async function classifyOwnedGroups(
  groups,
  observed,
  processResult,
  dependencies,
) {
  const alive = []
  const unproved = []
  for (const group of groups.values()) {
    const state = await classifyOwnedGroup(
      group,
      observed,
      processResult,
      dependencies,
    )
    if (state === 'alive') alive.push(group)
    if (state === 'unproved') unproved.push(group)
  }
  return { alive, unproved }
}

function unprovedOutsideOwnedGroups(processResult, groupResult) {
  const aliveGroupIds = new Set(
    groupResult.alive.map((group) => group.processGroupId),
  )
  return processResult.unproved.filter((record) => {
    const current = processResult.currentByPid.get(record.pid)
    return !current || !aliveGroupIds.has(current.processGroupId)
  })
}

async function groupSignalAdmission(
  targetGroup,
  observed,
  ownedGroups,
  loadProcessTable,
  dependencies,
) {
  const entries = await loadProcessTable()
  await adoptOwnedSnapshot(observed, ownedGroups, entries, dependencies)
  const processResult = await classifyObservedProcesses(
    observed,
    entries,
    dependencies,
  )
  const groupResult = await classifyOwnedGroups(
    ownedGroups,
    observed,
    processResult,
    dependencies,
  )
  const quarantineResult = await unresolvedQuarantineProcessGroups(
    dependencies.quarantinedProcesses,
    observed,
    entries,
    dependencies,
  )
  if (
    unprovedOutsideOwnedGroups(processResult, groupResult).length > 0 ||
    groupResult.unproved.length > 0 ||
    quarantineResult.records.length > 0
  ) {
    const error = new SmokeHarnessError('process-identity-unproved')
    if (quarantineResult.records.length > 0) {
      error.reasonTag = 'cleanup-quarantine-unresolved'
    }
    throw error
  }
  return groupResult.alive.some(
    (group) => group.processGroupId === targetGroup.processGroupId,
  )
}

/**
 * Wait until every tracked process and owned group exits, confirmed by two
 * authoritative empty scans when required.
 *
 * @param {Map<string, object>} observed - The durable process records.
 * @param {number} timeoutMs - The wait bound in milliseconds.
 * @param {string} [errorCode] - The failure code for a timeout.
 * @param {object} [dependencies] - Injected identity and signaling
 *   dependencies.
 * @throws {Error} On a lingering, unproved, or quarantined process identity.
 */
export async function waitForProcessesGone(
  observed,
  timeoutMs,
  errorCode = 'orphan-process',
  dependencies = {},
) {
  const deadline = Date.now() + timeoutMs
  const loadProcessTable =
    dependencies.readProcessTable ??
    (() =>
      readProcessTable({
        identityKey: dependencies.identityKey,
        ownershipToken: dependencies.ownershipToken,
        platform: dependencies.platform ?? process.platform,
        readFile: dependencies.readFile,
        readProcessUserId: dependencies.readProcessUserId,
        requiredPids: new Set(
          [...observed.values()].map((record) => record.pid),
        ),
        retainedRecords: [...observed.values()],
      }))
  const send = dependencies.kill ?? process.kill.bind(process)
  const ownedGroups = dependencies.ownedGroups ?? new Map()
  let consecutiveEmptyTokenScans = 0

  while (Date.now() < deadline) {
    const entries = await loadProcessTable()
    await adoptOwnedSnapshot(observed, ownedGroups, entries, dependencies)
    const processResult = await classifyObservedProcesses(
      observed,
      entries,
      dependencies,
    )
    const groupResult = await classifyOwnedGroups(
      ownedGroups,
      observed,
      processResult,
      dependencies,
    )
    const quarantineResult = await unresolvedQuarantineProcessGroups(
      dependencies.quarantinedProcesses,
      observed,
      entries,
      dependencies,
    )
    if (dependencies.signal) {
      for (const record of processResult.alive) {
        if (record.pid <= 1 || record.pid === process.pid) continue
        const current = processResult.currentByPid.get(record.pid)
        const currentState = await classifyProcess(record, current, {
          ...dependencies,
          platform: dependencies.platform ?? process.platform,
        })
        if (currentState === 'dead') continue
        if (currentState !== 'alive') {
          throw new SmokeHarnessError('process-identity-unproved')
        }
        try {
          send(record.pid, dependencies.signal)
        } catch {
          // Let the next identity scan remain authoritative.
        }
      }
      for (const group of groupResult.alive) {
        if (quarantineResult.processGroupIds.has(group.processGroupId)) continue
        if (group.processGroupId <= 1 || group.processGroupId === process.pid) {
          continue
        }
        if (
          !(await groupSignalAdmission(
            group,
            observed,
            ownedGroups,
            loadProcessTable,
            dependencies,
          ))
        ) {
          continue
        }
        try {
          send(-group.processGroupId, dependencies.signal)
        } catch {
          // Let the next identity scan remain authoritative.
        }
      }
    }
    if (
      unprovedOutsideOwnedGroups(processResult, groupResult).length > 0 ||
      groupResult.unproved.length > 0 ||
      quarantineResult.records.length > 0
    ) {
      const error = new SmokeHarnessError('process-identity-unproved')
      if (quarantineResult.records.length > 0) {
        error.reasonTag = 'cleanup-quarantine-unresolved'
      }
      throw error
    }
    const markedProcessAlive =
      dependencies.ownershipToken &&
      entries.some((entry) => entry.ownershipTokenMatched === true)
    if (
      processResult.alive.length === 0 &&
      groupResult.alive.length === 0 &&
      !markedProcessAlive
    ) {
      consecutiveEmptyTokenScans += 1
      if (!dependencies.ownershipToken || consecutiveEmptyTokenScans >= 2) {
        return
      }
    } else {
      consecutiveEmptyTokenScans = 0
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new SmokeHarnessError(errorCode)
}

/**
 * Wait for one child process to exit within a bounded duration.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs - The wait bound in milliseconds.
 * @throws {Error} On a child that does not exit before the deadline.
 */
export function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      cleanup()
      rejectExit(new SmokeHarnessError('electron-exit-timeout'))
    }, timeoutMs)
    const onExit = () => {
      cleanup()
      resolveExit()
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  })
}

/**
 * Wait for one child process to publish a valid process ID.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [timeoutMs] - The wait bound in milliseconds.
 * @throws {Error} On a launch failure, a missing process ID, or a timeout.
 */
export function waitForChildSpawn(child, timeoutMs = 3_000) {
  if (Number.isSafeInteger(child.pid) && child.pid > 1) {
    return Promise.resolve()
  }
  return new Promise((resolveSpawn, rejectSpawn) => {
    const timer = setTimeout(() => {
      cleanup()
      rejectSpawn(new SmokeHarnessError('electron-spawn-timeout'))
    }, timeoutMs)
    const onSpawn = () => {
      cleanup()
      if (Number.isSafeInteger(child.pid) && child.pid > 1) {
        resolveSpawn()
      } else {
        rejectSpawn(new SmokeHarnessError('electron-pid-missing'))
      }
    }
    const onError = () => {
      cleanup()
      rejectSpawn(new SmokeHarnessError('electron-launch-failed'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

function releaseChildStdio(child) {
  for (const stream of child.stdio ?? []) {
    if (stream && typeof stream.destroy === 'function') stream.destroy()
  }
}

/**
 * Signal only processes and groups with revalidated ownership.
 *
 * @param {Map<string, object>} observed - The durable process records.
 * @param {NodeJS.Signals} signal
 * @param {object} [dependencies] - Injected identity and signaling
 *   dependencies.
 * @throws {Error} On an unproved or quarantined process identity.
 */
export async function signalTrackedProcesses(
  observed,
  signal,
  dependencies = {},
) {
  const send = dependencies.kill ?? process.kill.bind(process)
  if (dependencies.matchingProcesses) {
    const current = await dependencies.matchingProcesses(observed)
    const currentPids = new Set(current.map((record) => record.pid))
    for (const record of observed.values()) {
      if (record.pid <= 1 || record.pid === process.pid) continue
      if (!currentPids.has(record.pid)) continue
      try {
        send(record.pid, signal)
      } catch {
        // Let the verification pass distinguish exit from uncertainty.
      }
    }
    return
  }

  const loadProcessTable =
    dependencies.readProcessTable ??
    (() =>
      readProcessTable({
        identityKey: dependencies.identityKey,
        ownershipToken: dependencies.ownershipToken,
        platform: dependencies.platform ?? process.platform,
        readFile: dependencies.readFile,
        readProcessUserId: dependencies.readProcessUserId,
        requiredPids: new Set(
          [...observed.values()].map((record) => record.pid),
        ),
        retainedRecords: [...observed.values()],
      }))
  const entries = await loadProcessTable()
  const ownedGroups = dependencies.ownedGroups ?? new Map()
  await adoptOwnedSnapshot(observed, ownedGroups, entries, dependencies)
  const processResult = await classifyObservedProcesses(
    observed,
    entries,
    dependencies,
  )
  const groupResult = await classifyOwnedGroups(
    ownedGroups,
    observed,
    processResult,
    dependencies,
  )
  const quarantineResult = await unresolvedQuarantineProcessGroups(
    dependencies.quarantinedProcesses,
    observed,
    entries,
    dependencies,
  )
  for (const record of processResult.alive) {
    if (record.pid <= 1 || record.pid === process.pid) continue
    const current = processResult.currentByPid.get(record.pid)
    const currentState = await classifyProcess(record, current, dependencies)
    if (currentState === 'dead') continue
    if (currentState !== 'alive') {
      throw new SmokeHarnessError('process-identity-unproved')
    }
    try {
      send(record.pid, signal)
    } catch {
      // Let the verification pass distinguish an exited process from uncertainty.
    }
  }
  for (const group of groupResult.alive) {
    if (quarantineResult.processGroupIds.has(group.processGroupId)) continue
    if (group.processGroupId <= 1 || group.processGroupId === process.pid) {
      continue
    }
    if (
      !(await groupSignalAdmission(
        group,
        observed,
        ownedGroups,
        loadProcessTable,
        dependencies,
      ))
    ) {
      continue
    }
    try {
      send(-group.processGroupId, signal)
    } catch {
      // Let the verification pass distinguish an exited group from uncertainty.
    }
  }
  if (
    unprovedOutsideOwnedGroups(processResult, groupResult).length > 0 ||
    groupResult.unproved.length > 0 ||
    quarantineResult.records.length > 0
  ) {
    const error = new SmokeHarnessError('process-identity-unproved')
    if (quarantineResult.records.length > 0) {
      error.reasonTag = 'cleanup-quarantine-unresolved'
    }
    throw error
  }
}

function signalRootProcess(child, signal) {
  try {
    child.kill(signal)
  } catch {
    // Let the bounded identity verification below remain authoritative.
  }
}

function signalRootProcessGroup(child, signal) {
  if (
    process.platform !== 'win32' &&
    child.exitCode == null &&
    child.signalCode == null
  ) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through to the immediate child when the group already exited.
    }
  }
  signalRootProcess(child, signal)
}

/**
 * Preserve detached-process ownership if an outer timeout interrupts the
 * harness. Send TERM immediately, then send KILL after a short bounded grace.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => Map<string, object>} observedSnapshot - Reads the current
 *   durable process records.
 * @param {object} [dependencies] - Injected runtime and signaling dependencies.
 * @returns {object} The interruption state and listener cleanup controls.
 */
export function installHarnessSignalHandlers(
  child,
  observedSnapshot,
  dependencies = {},
) {
  const runtime = dependencies.runtime ?? process
  const signalRoot = dependencies.signalRoot ?? signalRootProcessGroup
  const signalObserved = dependencies.signalObserved ?? signalTrackedProcesses
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  let interrupted = false
  let escalationTimer = null

  const terminate = () => {
    if (interrupted) return
    interrupted = true
    signalRoot(child, 'SIGTERM')
    void signalObserved(observedSnapshot(), 'SIGTERM').catch(() => undefined)
    escalationTimer = setTimeout(() => {
      signalRoot(child, 'SIGKILL')
      void signalObserved(observedSnapshot(), 'SIGKILL').catch(() => undefined)
    }, 1_000)
  }

  for (const signal of signals) runtime.on(signal, terminate)
  return {
    interrupted: () => interrupted,
    dispose() {
      for (const signal of signals) runtime.off(signal, terminate)
      if (escalationTimer) clearTimeout(escalationTimer)
    },
  }
}

async function terminateTrackedLaunch(child, observed, dependencies = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Treat a failed spawn as having no process tree to prove.
    }
    if (child.exitCode === null && child.signalCode === null) {
      await waitForChildExit(child, 1_000).catch(() => undefined)
    }
    return
  }
  if (
    child.exitCode === null &&
    child.signalCode === null &&
    (dependencies.ownedGroups?.size ?? 0) === 0
  ) {
    if ((dependencies.quarantinedProcesses?.length ?? 0) > 0) {
      signalRootProcess(child, 'SIGTERM')
    } else {
      signalRootProcessGroup(child, 'SIGTERM')
    }
  }
  await signalTrackedProcesses(observed, 'SIGTERM', dependencies)
  let treeGone = true
  try {
    await waitForProcessesGone(observed, 1_000, 'process-cleanup-unproved', {
      ...dependencies,
      signal: 'SIGTERM',
    })
  } catch {
    treeGone = false
  }
  let rootGone = child.exitCode !== null || child.signalCode !== null
  if (!rootGone) {
    rootGone = await waitForChildExit(child, 1_000).then(
      () => true,
      () => false,
    )
  }
  if (!treeGone || !rootGone) {
    if (!rootGone) {
      if ((dependencies.ownedGroups?.size ?? 0) === 0) {
        if ((dependencies.quarantinedProcesses?.length ?? 0) > 0) {
          signalRootProcess(child, 'SIGKILL')
        } else {
          signalRootProcessGroup(child, 'SIGKILL')
        }
      }
    }
    await signalTrackedProcesses(observed, 'SIGKILL', dependencies)
    await waitForProcessesGone(
      observed,
      PROCESS_EXIT_TIMEOUT_MS,
      'process-cleanup-unproved',
      { ...dependencies, signal: 'SIGKILL' },
    )
  }
  if (child.exitCode === null && child.signalCode === null) {
    await waitForChildExit(child, PROCESS_EXIT_TIMEOUT_MS).catch(() => {
      throw new SmokeHarnessError('process-cleanup-unproved')
    })
  }
}

/**
 * Remove the isolated smoke-test user-data directory within a bounded duration.
 *
 * @param {string} path - The isolated user-data directory.
 * @param {object} [dependencies] - Injected removal dependencies.
 * @throws {Error} On a removal failure or a timeout.
 */
export async function removeUserDataDirectory(path, dependencies = {}) {
  const remove = dependencies.rm ?? rm
  const timeoutMs = dependencies.timeoutMs ?? USER_DATA_CLEANUP_TIMEOUT_MS
  let timer
  try {
    await Promise.race([
      Promise.resolve().then(() =>
        remove(path, { recursive: true, force: true, maxRetries: 3 }),
      ),
      new Promise((_, rejectRemoval) => {
        timer = setTimeout(
          () =>
            rejectRemoval(new SmokeHarnessError('user-data-cleanup-timeout')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Directly launch one packaged executable and verify bounded cleanup.
 *
 * @param {object} options - The validated smoke-harness options.
 * @returns {Promise<object>} The fixed verified smoke-test report.
 * @throws {Error} On a launch, report, exit, process-identity, or cleanup
 *   failure.
 */
export async function runPackageSmokeHarness(options) {
  await access(options.executable, constants.X_OK)
  const userDataDir = await mkdtemp(join(tmpdir(), 'supraspina-package-smoke-'))
  const ownershipToken = randomUUID()
  const launcherNeedsNoSandbox =
    !options.allowNoSandbox &&
    (await appImageLauncherNeedsNoSandbox(options.artifactType))
  const processDependencies = {
    ownershipToken,
    platform: process.platform,
  }
  let child = null
  let tracker = null
  let reportCapture = null
  let signalHandlers = null
  let observed = new Map()
  let ownedGroups = new Map()
  let quarantinedProcesses = []

  try {
    child = spawn(
      options.executable,
      buildElectronLaunchArgs({
        userDataDir,
        allowNoSandbox: options.allowNoSandbox,
      }),
      {
        cwd: userDataDir,
        detached: process.platform !== 'win32',
        env: smokeChildEnvironment(
          options.allowNoSandbox,
          ownershipToken,
          options.nativeScience,
          launcherNeedsNoSandbox,
        ),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    reportCapture = startAppReportCapture(
      child,
      options.timeoutMs,
      process.platform,
      options.nativeScience,
    )
    void reportCapture.report.catch(() => undefined)
    child.stderr?.resume()
    signalHandlers = installHarnessSignalHandlers(
      child,
      () => tracker?.snapshot() ?? observed,
      {
        signalRoot: (launch, signal) => {
          if (!tracker) {
            signalRootProcessGroup(launch, signal)
            return
          }
          if (tracker.snapshot().size === 0) {
            if (tracker.quarantineSnapshot().length > 0) {
              signalRootProcess(launch, signal)
            } else {
              signalRootProcessGroup(launch, signal)
            }
          }
        },
        signalObserved: (records, signal) =>
          tracker
            ? tracker.adoptAndSignal(signal)
            : signalTrackedProcesses(records, signal, {
                ...processDependencies,
                ownedGroups,
              }),
      },
    )
    await waitForChildSpawn(child)
    if (!Number.isSafeInteger(child.pid)) {
      throw new SmokeHarnessError('electron-pid-missing')
    }
    tracker = startProcessTracker(child.pid, {
      expectedRootOwner:
        process.platform === 'win32' || typeof process.getuid !== 'function'
          ? undefined
          : {
              parentPid: process.pid,
              processGroupId: child.pid,
              userId: process.getuid(),
            },
      ownershipToken,
    })
    await tracker.ready
    const report = await reportCapture.report
    await waitForChildExit(child, PROCESS_EXIT_TIMEOUT_MS)
    const expectedExitCode = report.ok ? 0 : 1
    if (child.signalCode !== null || child.exitCode !== expectedExitCode) {
      throw new SmokeHarnessError('electron-exit-status')
    }
    observed = await tracker.stop()
    ownedGroups = tracker.groupSnapshot()
    tracker = null
    await waitForProcessesGone(
      observed,
      PROCESS_EXIT_TIMEOUT_MS,
      'orphan-process',
      {
        ...processDependencies,
        ownedGroups,
      },
    )
    await reportCapture.finish(PROCESS_EXIT_TIMEOUT_MS)
    reportCapture = null
    releaseChildStdio(child)
    if (signalHandlers.interrupted()) {
      throw new SmokeHarnessError('harness-interrupted')
    }

    return {
      schemaVersion: 1,
      ok: report.ok === true,
      artifactType: options.artifactType,
      app: report,
      harness: {
        isolatedUserData: true,
        electronExited: true,
        noOrphanProcesses: true,
        noSandbox: options.allowNoSandbox,
      },
    }
  } finally {
    let cleanupError = null
    if (tracker && child) {
      await tracker.adoptAndSignal('SIGTERM').catch(() => undefined)
      quarantinedProcesses = tracker.quarantineSnapshot()
      await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    }
    if (tracker) {
      try {
        observed = await tracker.stop()
        ownedGroups = tracker.groupSnapshot()
      } catch (error) {
        observed = tracker.snapshot()
        ownedGroups = tracker.groupSnapshot()
        cleanupError ??= tagSmokeError(error, 'tracker-stop-identity')
      }
      quarantinedProcesses = tracker.quarantineSnapshot()
      tracker = null
    }
    if (child) {
      try {
        await terminateTrackedLaunch(child, observed, {
          ...processDependencies,
          ownedGroups,
          quarantinedProcesses,
        })
      } catch (error) {
        cleanupError ??= tagSmokeError(error, 'cleanup-terminate-identity')
      } finally {
        releaseChildStdio(child)
      }
    }
    if (reportCapture) {
      reportCapture.stop()
    }
    try {
      await removeUserDataDirectory(userDataDir)
    } catch (error) {
      if (cleanupError === null) cleanupError = error
    }
    if (signalHandlers?.interrupted() && cleanupError === null) {
      cleanupError = new SmokeHarnessError('harness-interrupted')
    }
    signalHandlers?.dispose()
    // Report a cleanup failure even though the body already returned or threw:
    // an unreaped process or a surviving user-data directory invalidates the
    // smoke result, so it must not be swallowed.
    // eslint-disable-next-line no-unsafe-finally
    if (cleanupError) throw cleanupError
  }
}

function usage() {
  return [
    'Run:',
    '  node scripts/package-smoke.mjs --executable <path> --type <type>',
    '    [--timeout-ms 60000] [--no-sandbox] [--native-science]',
    '',
    'Choose a type: appimage, deb, or unpacked.',
    'Use --no-sandbox only on Linux with CI=true and explicit opt-in.',
    'Use --native-science only for native-host PyBrainAge release acceptance.',
  ].join('\n')
}

async function main() {
  let options
  try {
    options = parsePackageSmokeArguments(process.argv.slice(2))
  } catch (error) {
    const code =
      error instanceof SmokeHarnessError ? error.code : 'invalid-arguments'
    process.stderr.write(`package-smoke: ${code}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  try {
    const result = await runPackageSmokeHarness(options)
    process.stdout.write(`${PACKAGE_SMOKE_VERIFIED}${JSON.stringify(result)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    const code =
      error instanceof SmokeHarnessError ? error.code : 'harness-failed'
    process.stderr.write(`package-smoke: ${code}\n`)
    if (process.env.SUPRASPINA_SMOKE_REASON_TAG === '1') {
      const reasonTag = safeSmokeReasonTag(error?.reasonTag)
      if (reasonTag)
        process.stderr.write(`package-smoke-reason: ${reasonTag}\n`)
    }
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main()
}
