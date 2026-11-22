/** Tests for the packaged smoke harness launch policy. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  PACKAGE_SMOKE_SENTINEL,
  appImageLauncherNeedsNoSandbox,
  buildElectronLaunchArgs,
  containsSensitiveSmokeDiagnostic,
  installHarnessSignalHandlers,
  linuxOwnedProcessSnapshot,
  linuxProcessEffectiveUserId,
  parsePackageSmokeArguments,
  processRecord,
  readProcessTable,
  removeUserDataDirectory,
  safeSmokeReasonTag,
  signalTrackedProcesses,
  smokeChildEnvironment,
  startAppReportCapture,
  startProcessTracker,
  validAppReport,
  waitForChildExit,
  waitForChildSpawn,
  waitForProcessesGone,
} from './package-smoke.mjs'

/** The harness accepts only the committed product version, so derive it. */
const PRODUCT_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

function passingAppReport(platform = 'linux') {
  return {
    schemaVersion: 1,
    productVersion: PRODUCT_VERSION,
    sidecarProductVersion: PRODUCT_VERSION,
    ok: true,
    platform,
    failureCode: null,
    checks: {
      packagedMode: true,
      noSandboxPolicy: true,
      resourcesPathAbsolute: true,
      appAsar: true,
      rendererEntryInAsar: true,
      preloadEntryInAsar: true,
      externalIcon: true,
      frozenSidecarLauncher: true,
      frozenSidecarRuntime: true,
      frozenSidecarExecutable: true,
      bundledMicromamba: true,
      bundledMicromambaExecutable: true,
      noDeveloperOverrides: true,
      rendererPoisonIgnored: true,
      firstPartyLicense: true,
      thirdPartyNotices: true,
      thirdPartyProvenance: true,
      dependencyManifests: true,
      scientificAcquisitionMetadata: true,
      unresolvedUpstreamAssetsExcluded: true,
      mainStarted: true,
      rendererStarted: true,
      preloadBridge: true,
      rendererSandboxed: true,
      hostIpcRoundTrip: true,
      sidecarHandshake: true,
      safeNoProject: true,
      clinicalOpenpyxlRuntime: true,
      clinicalDiscoveryDone: true,
      clinicalRefreshDone: true,
      clinicalMissingColumnsRejected: true,
      clinicalEmptyRequiredRejected: true,
      clinicalMalformedRejected: true,
      clinicalMissingDependencyRejected: true,
      clinicalLiveZeroExit: true,
      clinicalReceiptDurable: true,
      clinicalBrainpadEligible: true,
      clinicalOutputReopened: true,
      nativeScienceRequested: false,
      pybrainageProvisioned: false,
      pybrainageReady: false,
      pybrainagePredictionReopened: false,
      clinicalProjectDetached: true,
      clinicalTemporaryDataRemoved: true,
      updaterIdle: true,
      noUpdateNetwork: true,
      rendererLocalResources: true,
      computerModernFaces: true,
      fontSynthesisDisabled: true,
      noProcessErrors: true,
      noRendererErrors: true,
      noSensitiveDiagnostics: true,
      sidecarStopped: true,
    },
  }
}

function reportChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  return child
}

function linuxProcessStat(processEntry, startTicks) {
  const fields = Array.from({ length: 20 }, () => '0')
  fields[0] = 'S'
  fields[1] = String(processEntry.parentPid)
  fields[2] = String(processEntry.processGroupId)
  fields[19] = String(startTicks)
  return `${processEntry.pid} (${processEntry.command}) ${fields.join(' ')}`
}

function processRowMetadata({
  parentPid,
  pid,
  processGroupId,
  startedAt = 'Thu Jul 23 07:00:00 2026',
  userId,
}) {
  return `${pid} ${parentPid} ${processGroupId} ${userId} ${startedAt}`
}

function ownershipProcessRow(processEntry, environmentTail = '') {
  return `${processRowMetadata(processEntry)} ${environmentTail}\n`
}

function safeProcessRow(processEntry) {
  return `${processRowMetadata(processEntry)} ${processEntry.command}\n`
}

async function safeOnlyGroupBirthFixture() {
  const ownershipToken = 'fixed-token'
  const root = {
    command: 'launcher',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    userId: 1000,
  }
  const groupMember = {
    command: 'extract-helper',
    parentPid: 1,
    pid: 78,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
  }
  const missing = new Error('gone')
  missing.code = 'ENOENT'
  let memberAlive = true
  const readIdentity = async (path) => {
    const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
    if (pid === groupMember.pid && !memberAlive) throw missing
    return linuxProcessStat(pid === root.pid ? root : groupMember, 100 + pid)
  }
  let captureCalls = 0
  let captureError = null
  try {
    await readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        captureCalls += 1
        if (captureCalls === 1) {
          return {
            stdout: ownershipProcessRow(
              root,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ),
          }
        }
        return {
          stdout: safeProcessRow(root) + safeProcessRow(groupMember),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      readFile: readIdentity,
      readProcessUserId: async () => root.userId,
    })
  } catch (error) {
    captureError = error
  }
  assert.equal(captureCalls, 2)
  assert.ok(captureError)
  return {
    captureError,
    coherentMember: { ...groupMember, ownershipTokenMatched: false },
    coherentRoot: { ...root, ownershipTokenMatched: true },
    groupMember,
    markMemberDead: () => {
      memberAlive = false
    },
    ownershipToken,
    readIdentity,
    root,
  }
}

test('app report accepts only the fixed path-free boolean schema', () => {
  const report = passingAppReport()
  assert.equal(validAppReport(report, 'linux'), true)
  assert.equal(
    validAppReport({ ...report, diagnostics: '/data/study/sub-001' }, 'linux'),
    false,
  )
  assert.equal(
    validAppReport(
      {
        ...report,
        checks: { ...report.checks, patient_name: 'Example Person' },
      },
      'linux',
    ),
    false,
  )
  assert.equal(validAppReport(report, 'darwin'), false)
  assert.equal(
    validAppReport(
      { ...report, sidecarProductVersion: '20000101.0.0' },
      'linux',
    ),
    false,
  )
  const nativeReport = passingAppReport()
  Object.assign(nativeReport.checks, {
    nativeScienceRequested: true,
    pybrainageProvisioned: true,
    pybrainageReady: true,
    pybrainagePredictionReopened: true,
  })
  assert.equal(validAppReport(nativeReport, 'linux', true), true)
  assert.equal(validAppReport(nativeReport, 'linux', false), false)
})

test('diagnostic scan rejects PHI, local paths, and credentials', () => {
  for (const value of [
    'file:///home/operator/study/report.json',
    '/data/derivatives/study/sub-001',
    '/workspace/custom/study.json',
    'participant_id=sub-001',
    'patient_name: Example Person',
    'operator@example.org',
    'Authorization: Bearer private-token',
  ]) {
    assert.equal(containsSensitiveSmokeDiagnostic(value), true)
  }
})

test('smoke reason diagnostics allow only fixed path-free tags', () => {
  assert.equal(
    safeSmokeReasonTag('capture-ambiguous-birth-persistent'),
    'capture-ambiguous-birth-persistent',
  )
  assert.equal(safeSmokeReasonTag('/data/study/sub-001'), null)
  assert.equal(safeSmokeReasonTag('capture-ambiguous-birth\nsecret'), null)
})

test('direct stdout capture cannot miss an immediately published report', async () => {
  const child = reportChild()
  const capture = startAppReportCapture(child, 1_000, 'linux')
  const expected = passingAppReport()

  child.stdout.end(`${PACKAGE_SMOKE_SENTINEL}${JSON.stringify(expected)}\n`)
  child.exitCode = 0
  child.emit('exit', 0, null)

  assert.deepEqual(await capture.report, expected)
  assert.deepEqual(await capture.finish(1_000), expected)
})

test('direct stdout capture accepts a chunk-split CRLF report', async () => {
  const child = reportChild()
  const capture = startAppReportCapture(child, 1_000, 'linux')
  const expected = passingAppReport()
  const line = `${PACKAGE_SMOKE_SENTINEL}${JSON.stringify(expected)}\r\n`

  child.stdout.write(line.slice(0, 23))
  child.stdout.end(line.slice(23))

  assert.deepEqual(await capture.report, expected)
  assert.deepEqual(await capture.finish(1_000), expected)
})

test('direct stdout capture accepts an AppImage extraction prefix', async () => {
  const child = reportChild()
  const capture = startAppReportCapture(child, 1_000, 'linux')
  const expected = passingAppReport()

  child.stdout.end(`/tmp${PACKAGE_SMOKE_SENTINEL}${JSON.stringify(expected)}\n`)

  assert.deepEqual(await capture.report, expected)
  assert.deepEqual(await capture.finish(1_000), expected)
})

test('root exit before final stdout delivery does not lose the report', async () => {
  const child = reportChild()
  const capture = startAppReportCapture(child, 1_000, 'linux')
  const expected = passingAppReport()

  child.exitCode = 0
  child.emit('exit', 0, null)
  child.stdout.end(`${PACKAGE_SMOKE_SENTINEL}${JSON.stringify(expected)}\n`)

  assert.deepEqual(await capture.report, expected)
  assert.deepEqual(await capture.finish(1_000), expected)
})

test('direct stdout capture rejects duplicate reports after the first', async () => {
  const child = reportChild()
  const capture = startAppReportCapture(child, 1_000, 'linux')
  const line = `${PACKAGE_SMOKE_SENTINEL}${JSON.stringify(passingAppReport())}\n`

  child.stdout.end(`${line}${line}`)
  assert.deepEqual(await capture.report, passingAppReport())
  await assert.rejects(capture.finish(1_000), /duplicate-app-report/)
})

test('direct stdout capture rejects malformed, missing, and oversized reports', async () => {
  const malformedChild = reportChild()
  const malformed = startAppReportCapture(malformedChild, 1_000, 'linux')
  malformedChild.stdout.end(`${PACKAGE_SMOKE_SENTINEL}{broken}\n`)
  await assert.rejects(malformed.report, /invalid-app-report/)
  malformed.stop()

  const missingChild = reportChild()
  const missing = startAppReportCapture(missingChild, 1_000, 'linux')
  missingChild.exitCode = 1
  missingChild.stdout.end()
  await assert.rejects(missing.report, /app-report-missing/)
  missing.stop()

  const oversizedChild = reportChild()
  const oversized = startAppReportCapture(oversizedChild, 1_000, 'linux')
  oversizedChild.stdout.end('x'.repeat(1024 * 1024 + 1))
  await assert.rejects(oversized.report, /app-report-output-too-large/)
  oversized.stop()

  const unterminatedChild = reportChild()
  const unterminated = startAppReportCapture(unterminatedChild, 1_000, 'linux')
  unterminatedChild.stdout.end(
    `${PACKAGE_SMOKE_SENTINEL}${JSON.stringify(passingAppReport())}`,
  )
  await assert.rejects(unterminated.report, /unterminated-app-report/)
  unterminated.stop()
})

test('normal smoke launch arguments never disable the Chromium sandbox', () => {
  const args = buildElectronLaunchArgs({
    userDataDir: '/tmp/supraspina-smoke-profile',
    allowNoSandbox: false,
  })

  assert.deepEqual(args, [
    '--supraspina-smoke-test',
    '--user-data-dir=/tmp/supraspina-smoke-profile',
  ])
  assert.equal(args.includes('--no-sandbox'), false)
  assert.equal(args.includes('--inspect=0'), false)
  assert.equal(args.includes('-r'), false)
})

test('AppImage smoke mirrors the launcher user-namespace fallback', async () => {
  assert.equal(
    await appImageLauncherNeedsNoSandbox('appimage', 'linux', {
      execFile: async () => ({ stdout: '', stderr: '' }),
    }),
    false,
  )
  assert.equal(
    await appImageLauncherNeedsNoSandbox('appimage', 'linux', {
      execFile: async () => {
        throw new Error('user namespaces unavailable')
      },
    }),
    true,
  )
  assert.equal(
    await appImageLauncherNeedsNoSandbox('deb', 'linux', {
      execFile: async () => {
        throw new Error('must not run')
      },
    }),
    false,
  )
})

test('AppImage fallback authorizes only the launcher-selected exception', () => {
  const env = smokeChildEnvironment(false, 'fixed-ownership-token', false, true)

  assert.equal(env.CI, 'true')
  assert.equal(env.SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX, '1')
  assert.equal(
    buildElectronLaunchArgs({
      userDataDir: '/tmp/x',
      allowNoSandbox: false,
    }).includes('--no-sandbox'),
    false,
  )
})

test('explicit Linux CI opt-in adds only the no-sandbox exception', () => {
  const options = parsePackageSmokeArguments(
    ['--executable', '/opt/supraspina', '--type', 'unpacked', '--no-sandbox'],
    { CI: 'true' },
    'linux',
  )
  assert.equal(options.allowNoSandbox, true)

  const args = buildElectronLaunchArgs({
    userDataDir: '/tmp/supraspina-smoke-profile',
    allowNoSandbox: options.allowNoSandbox,
  })
  assert.deepEqual(args, [
    '--supraspina-smoke-test',
    '--user-data-dir=/tmp/supraspina-smoke-profile',
    '--no-sandbox',
  ])
})

test('direct launch environment removes developer injection surfaces', () => {
  const prior = {
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    SUPRASPINA_SIDECAR: process.env.SUPRASPINA_SIDECAR,
    SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX:
      process.env.SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX,
    SUPRASPINA_SMOKE_PROCESS_TOKEN: process.env.SUPRASPINA_SMOKE_PROCESS_TOKEN,
    SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE:
      process.env.SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE,
  }
  Object.assign(process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--require attacker',
    SUPRASPINA_SIDECAR: '/tmp/attacker',
    SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX: 'stale',
    SUPRASPINA_SMOKE_PROCESS_TOKEN: 'stale',
    SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE: 'stale',
  })
  try {
    const env = smokeChildEnvironment(false, 'fixed-ownership-token')

    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.SUPRASPINA_SIDECAR, undefined)
    assert.equal(env.SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX, undefined)
    assert.equal(env.SUPRASPINA_SMOKE_PROCESS_TOKEN, 'fixed-ownership-token')
    assert.equal(env.SUPRASPINA_PACKAGE_SMOKE, '1')
    assert.equal(env.SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE, undefined)
    assert.equal(env.ELECTRON_RENDERER_URL, 'https://127.0.0.1:9/attacker')
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('native science opt-in uses a bounded extended timeout and marker', () => {
  const options = parsePackageSmokeArguments(
    [
      '--executable',
      '/usr/bin/supraspina',
      '--type',
      'deb',
      '--native-science',
    ],
    {},
    'linux',
  )
  assert.equal(options.nativeScience, true)
  assert.equal(options.timeoutMs, 45 * 60 * 1_000)
  const env = smokeChildEnvironment(false, 'fixed-token', true)
  assert.equal(env.SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE, '1')
})

test('no-sandbox is rejected outside Linux CI', () => {
  assert.throws(
    () =>
      parsePackageSmokeArguments(
        [
          '--executable',
          '/opt/Supraspina/supraspina',
          '--type',
          'unpacked',
          '--no-sandbox',
        ],
        { CI: 'true' },
        'darwin',
      ),
    /artifact-platform-mismatch/,
  )
  assert.throws(
    () =>
      parsePackageSmokeArguments(
        ['--executable', '/opt/supraspina', '--type', 'deb', '--no-sandbox'],
        {},
        'linux',
      ),
    /no-sandbox-requires-linux-ci/,
  )
})

test('environment options support installed package executables', () => {
  const options = parsePackageSmokeArguments(
    [],
    {
      SUPRASPINA_SMOKE_EXECUTABLE: '/usr/bin/supraspina',
      SUPRASPINA_SMOKE_ARTIFACT_TYPE: 'deb',
    },
    'linux',
  )

  assert.equal(options.executable, '/usr/bin/supraspina')
  assert.equal(options.artifactType, 'deb')
  assert.equal(options.allowNoSandbox, false)
})

test('environment no-sandbox opt-in still requires Linux CI', () => {
  const options = parsePackageSmokeArguments(
    ['--executable', '/opt/supraspina', '--type', 'appimage'],
    { CI: '1', SUPRASPINA_SMOKE_NO_SANDBOX: '1' },
    'linux',
  )

  assert.equal(options.allowNoSandbox, true)
})

test('system process-table reads fail within their fixed command bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'supraspina-hung-ps-'))
  const executable = join(directory, 'hung-ps')
  await writeFile(
    executable,
    `#!${process.execPath}\nsetInterval(() => undefined, 30_000)\n`,
    { mode: 0o700 },
  )
  const startedAt = Date.now()

  try {
    await assert.rejects(
      readProcessTable({ executable, timeoutMs: 50 }),
      /process-table-timeout/,
    )
    assert.ok(Date.now() - startedAt < 2_000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Linux process ownership reads the effective UID and fails closed', async () => {
  assert.equal(
    await linuxProcessEffectiveUserId(42, {
      readFile: async () => 'Name:\ttest\nUid:\t501\t502\t503\t504\n',
    }),
    502,
  )
  await assert.rejects(
    linuxProcessEffectiveUserId(42, {
      readFile: async () => 'Name:\ttest\nUid:\tinvalid\n',
    }),
    /process-identity-unproved/,
  )
  const denied = new Error('denied')
  denied.code = 'EACCES'
  await assert.rejects(
    linuxProcessEffectiveUserId(42, {
      readFile: async () => {
        throw denied
      },
    }),
    /process-identity-unproved/,
  )
  const missing = new Error('gone')
  missing.code = 'ENOENT'
  await assert.rejects(
    linuxProcessEffectiveUserId(42, {
      readFile: async () => {
        throw missing
      },
    }),
    (error) => error === missing,
  )
})

test('Linux ownership treats status disappearance after stat as ended', async () => {
  const processEntry = {
    command: 'Supraspina',
    parentPid: 1,
    pid: 42,
    processGroupId: 42,
  }
  const missing = new Error('gone')
  missing.code = 'ENOENT'
  let statReads = 0

  assert.equal(
    await linuxOwnedProcessSnapshot(processEntry.pid, 1000, {
      readFile: async () => {
        statReads += 1
        return linuxProcessStat(processEntry, 142)
      },
      readProcessUserId: async () => {
        throw missing
      },
    }),
    null,
  )
  assert.equal(statReads, 1)
})

test('system process table finds the inherited ownership marker', async () => {
  const ownershipToken = `fixture-${process.pid}-${Date.now()}`
  const child = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => undefined, 30000)'],
    {
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        SUPRASPINA_SMOKE_PROCESS_TOKEN: ownershipToken,
      },
      stdio: 'ignore',
    },
  )
  await waitForChildSpawn(child)

  try {
    const entries = await readProcessTable({ ownershipToken })
    const owned = entries.find((entry) => entry.pid === child.pid)
    assert.equal(owned?.ownershipTokenMatched, true)
    // Node 24 renames its main thread, so the kernel reports "MainThread".
    assert.ok(['node', 'MainThread'].includes(owned?.command))
  } finally {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL')
      else process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The child already exited; there is nothing left to signal.
    }
    await waitForChildExit(child, 2_000)
  }
})

test('ownership scan never replaces the safe comm field with argv or env', async () => {
  const ownershipToken = 'fixed-token'
  const calls = []
  const processEntry = {
    command: 'trusted-helper',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    userId: 1000,
  }
  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async (_executable, args) => {
      calls.push(args)
      if (calls.length === 1) {
        return {
          stdout: ownershipProcessRow(
            processEntry,
            `untrusted-command --argument ${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken} private-environment /private/path`,
          ),
        }
      }
      return {
        stdout: safeProcessRow(processEntry),
      }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
  })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].slice(0, 2), ['eww', 'axo'])
  assert.match(calls[0][2], /lstart=,command=/)
  assert.deepEqual(calls[1].slice(0, 2), ['-ww', '-axo'])
  assert.match(calls[1][2], /lstart=,ucomm=/)
  assert.equal(rows[0].command, 'trusted-helper')
  assert.equal(rows[0].ownershipTokenMatched, true)
  assert.equal(JSON.stringify(rows).includes('untrusted-command'), false)
  assert.equal(JSON.stringify(rows).includes('private-environment'), false)
  assert.equal(JSON.stringify(rows).includes('/private/path'), false)
})

test('non-Linux POSIX ownership capture uses a coherent token scan and safe join', async () => {
  const ownershipToken = 'fixed-token'
  const calls = []
  const processEntry = {
    command: 'Supraspina',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    userId: 501,
  }
  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async (_executable, args) => {
      calls.push(args)
      if (calls.length === 1) {
        return {
          stdout: ownershipProcessRow(
            processEntry,
            `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
          ),
        }
      }
      return {
        stdout: safeProcessRow(processEntry),
      }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'darwin',
  })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].slice(0, 3), ['-E', '-ww', '-axo'])
  assert.match(calls[0][3], /lstart=,command=/)
  assert.deepEqual(calls[1].slice(0, 2), ['-ww', '-axo'])
  assert.match(calls[1][2], /lstart=,ucomm=/)
  assert.deepEqual(rows, [
    {
      command: 'Supraspina',
      ownershipTokenMatched: true,
      parentPid: 1,
      pid: 77,
      processGroupId: 77,
      startedAt: 'Thu Jul 23 07:00:00 2026',
      userId: 501,
    },
  ])
})

test('ownership capture rejects a vanished token parent with a surviving child', async () => {
  const ownershipToken = 'fixed-token'
  const parent = {
    command: 'launcher',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    userId: 1000,
  }
  const child = {
    command: 'scientific-child',
    parentPid: parent.pid,
    pid: 78,
    processGroupId: parent.processGroupId,
    userId: parent.userId,
  }
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout:
              ownershipProcessRow(
                parent,
                `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
              ) + ownershipProcessRow(child),
          }
        }
        return { stdout: safeProcessRow(child) }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 2)
})

test('ownership capture includes a safe-snapshot child of a stable owner', async () => {
  const ownershipToken = 'fixed-token'
  const parent = {
    command: 'launcher',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    userId: 1000,
  }
  const child = {
    command: 'scientific-child',
    parentPid: parent.pid,
    pid: 78,
    processGroupId: parent.processGroupId,
    userId: parent.userId,
  }
  let calls = 0

  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async () => {
      calls += 1
      if (calls === 1) {
        return {
          stdout: ownershipProcessRow(
            parent,
            `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
          ),
        }
      }
      return {
        stdout: safeProcessRow(parent) + safeProcessRow(child),
      }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
  })

  assert.deepEqual(
    rows.map((entry) => [entry.pid, entry.ownershipTokenMatched]),
    [
      [parent.pid, true],
      [child.pid, false],
    ],
  )
})

test('the tracker quarantines a safe-only group birth until ownership is coherent', async () => {
  const {
    captureError,
    coherentMember,
    coherentRoot,
    groupMember,
    ownershipToken,
    readIdentity,
    root,
  } = await safeOnlyGroupBirthFixture()
  assert.equal(captureError?.code, 'process-identity-unproved')
  assert.equal(captureError?.retryableQuarantine, true)
  assert.deepEqual(
    captureError?.processTableEntries.map((entry) => entry.pid),
    [root.pid, groupMember.pid],
  )
  assert.deepEqual(captureError?.quarantinedProcesses, [
    {
      parentPid: groupMember.parentPid,
      pid: groupMember.pid,
      processGroupId: groupMember.processGroupId,
      startIdentity: `linux:${100 + groupMember.pid}`,
      userId: groupMember.userId,
    },
  ])

  let tableReads = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken,
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: readIdentity,
    readProcessTable: async () => {
      tableReads += 1
      if (tableReads === 1) throw captureError
      return [coherentRoot, coherentMember]
    },
    readProcessUserId: async () => root.userId,
  })

  await tracker.ready

  assert.equal(tableReads, 2)
  assert.equal(
    [...tracker.snapshot().values()].some(
      (record) =>
        record.pid === groupMember.pid && record.ownershipBasis === 'ancestry',
    ),
    true,
  )
  assert.deepEqual(tracker.quarantineSnapshot(), [])
  await tracker.stop()
})

test('the tracker clears a transient safe-only group birth only after it is dead', async () => {
  const {
    captureError,
    coherentRoot,
    groupMember,
    markMemberDead,
    ownershipToken,
    readIdentity,
    root,
  } = await safeOnlyGroupBirthFixture()
  let tableReads = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken,
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: readIdentity,
    readProcessTable: async () => {
      tableReads += 1
      if (tableReads === 1) throw captureError
      markMemberDead()
      return [coherentRoot]
    },
    readProcessUserId: async () => root.userId,
  })

  await tracker.ready

  assert.equal(tableReads, 2)
  assert.equal(
    [...tracker.snapshot().values()].some(
      (record) => record.pid === groupMember.pid,
    ),
    false,
  )
  assert.deepEqual(tracker.quarantineSnapshot(), [])
  await tracker.stop()
})

test('cleanup quarantines a transient snapshot mismatch in an owned group', async () => {
  const ownershipToken = 'fixed-token'
  const root = {
    command: 'launcher',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const child = {
    command: 'appimage-child',
    parentPid: root.pid,
    pid: 78,
    processGroupId: root.processGroupId,
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const reparented = { ...child, parentPid: 1 }
  const missing = new Error('process disappeared')
  missing.code = 'ENOENT'
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken,
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.split('/')[2])
      if (pid === root.pid) return linuxProcessStat(root, 100)
      if (scans >= 3) throw missing
      return linuxProcessStat(reparented, 200)
    },
    readProcessTable: async () => {
      scans += 1
      if (scans === 1) return [root]
      if (scans === 2) return [root, child]
      return [root]
    },
  })

  await tracker.ready
  const signals = []
  await tracker.adoptAndSignal('SIGTERM', {
    kill: (pid, signal) => signals.push([pid, signal]),
  })
  const observed = await tracker.stop()

  assert.ok(scans >= 3)
  assert.ok(signals.length > 0)
  assert.deepEqual(
    [...observed.values()].map((record) => record.pid),
    [root.pid],
  )
  assert.deepEqual(tracker.quarantineSnapshot(), [])
})

test('cleanup rejects a persistent snapshot mismatch in an owned group', async () => {
  const ownershipToken = 'fixed-token'
  const root = {
    command: 'launcher',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const child = {
    command: 'appimage-child',
    parentPid: root.pid,
    pid: 78,
    processGroupId: root.processGroupId,
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const reparented = { ...child, parentPid: 1 }
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 20,
    ownershipToken,
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) =>
      linuxProcessStat(
        Number(path.split('/')[2]) === root.pid ? root : reparented,
        Number(path.split('/')[2]) === root.pid ? 100 : 200,
      ),
    readProcessTable: async () => {
      scans += 1
      return scans === 1 ? [root] : [root, child]
    },
  })

  await tracker.ready
  await assert.rejects(
    tracker.adoptAndSignal('SIGTERM', { kill: () => undefined }),
    /process-identity-unproved/,
  )

  assert.ok(scans > 2)
  assert.deepEqual(tracker.quarantineSnapshot(), [
    {
      parentPid: reparented.parentPid,
      pid: reparented.pid,
      processGroupId: reparented.processGroupId,
      startIdentity: 'linux:200',
      userId: reparented.userId,
    },
  ])
})

test('the tracker cannot retry away a persistent safe-only group birth', async () => {
  const {
    captureError,
    coherentRoot,
    groupMember,
    ownershipToken,
    readIdentity,
    root,
  } = await safeOnlyGroupBirthFixture()
  let tableReads = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 20,
    ownershipToken,
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: readIdentity,
    readProcessTable: async () => {
      tableReads += 1
      if (tableReads === 1) throw captureError
      return [coherentRoot]
    },
    readProcessUserId: async () => root.userId,
  })

  await assert.rejects(tracker.ready, /process-identity-unproved/)

  assert.ok(tableReads > 2)
  assert.equal(
    [...tracker.snapshot().values()].some(
      (record) => record.pid === groupMember.pid,
    ),
    false,
  )

  const signals = []
  await assert.rejects(
    tracker.adoptAndSignal('SIGTERM', {
      kill: (pid, signal) => signals.push([pid, signal]),
    }),
    /process-identity-unproved/,
  )
  assert.deepEqual(signals, [[root.pid, 'SIGTERM']])
  assert.deepEqual(tracker.quarantineSnapshot(), [
    captureError.quarantinedProcesses[0],
  ])

  await assert.rejects(tracker.stop(), /process-identity-unproved/)

  const cleanupSignals = []
  await assert.rejects(
    signalTrackedProcesses(tracker.snapshot(), 'SIGKILL', {
      kill: (pid, signal) => cleanupSignals.push([pid, signal]),
      ownedGroups: tracker.groupSnapshot(),
      ownershipToken,
      platform: 'linux',
      quarantinedProcesses: tracker.quarantineSnapshot(),
      readFile: readIdentity,
      readProcessTable: async () => [coherentRoot],
      readProcessUserId: async () => root.userId,
    }),
    /process-identity-unproved/,
  )
  assert.deepEqual(cleanupSignals, [[root.pid, 'SIGKILL']])
})

test('ownership capture rejects a required PID born between captures', async () => {
  const required = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    userId: 1000,
  }
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        return {
          stdout: calls === 1 ? '' : safeProcessRow(required),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      platform: 'linux',
      requiredPids: new Set([required.pid]),
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 2)
})

test('ownership capture reconciles a retained token process transition', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
  }
  const stable = {
    ...required,
    parentPid: 1,
  }
  let calls = 0

  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async () => {
      calls += 1
      if (calls === 1) {
        return {
          stdout: ownershipProcessRow(
            required,
            `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
          ),
        }
      }
      if (calls === 2) return { stdout: safeProcessRow(stable) }
      return {
        stdout: ownershipProcessRow(
          stable,
          `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
        ),
      }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
    requiredPids: new Set([required.pid]),
    retainedRecords: [
      {
        ownershipBasis: 'token',
        pid: required.pid,
        startedAt: required.startedAt,
        userId: required.userId,
      },
    ],
  })

  assert.equal(calls, 3)
  assert.equal(rows[0].parentPid, stable.parentPid)
  assert.equal(rows[0].ownershipTokenMatched, true)
})

test('Linux durable token reconciles a markerless process transition', async () => {
  const ownershipToken = 'fixed-token'
  const retainedEntry = {
    command: 'shell',
    parentPid: 100,
    pid: 78,
    processGroupId: 200,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const ownershipEntry = {
    ...retainedEntry,
    command: 'scientific-executable',
    parentPid: 77,
    processGroupId: 77,
    ownershipTokenMatched: false,
  }
  const transitioned = {
    ...ownershipEntry,
    parentPid: 1,
    processGroupId: ownershipEntry.pid,
  }
  const retained = await processRecord(retainedEntry, 1, {
    ownershipBasis: 'token',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(retainedEntry, 777),
  })
  let calls = 0

  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async () => {
      calls += 1
      if (calls === 1) return { stdout: ownershipProcessRow(ownershipEntry) }
      if (calls === 2) return { stdout: safeProcessRow(transitioned) }
      return { stdout: ownershipProcessRow(transitioned) }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(transitioned, 777),
    requiredPids: new Set([retained.pid]),
    retainedRecords: [retained],
  })

  assert.equal(calls, 3)
  assert.equal(rows[0].parentPid, transitioned.parentPid)
  assert.equal(rows[0].processGroupId, transitioned.processGroupId)
  assert.equal(rows[0].ownershipTokenMatched, false)
})

test('Linux token transition cannot bypass effective UID validation', async () => {
  const ownershipToken = 'fixed-token'
  const original = {
    command: 'shell',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const reparented = { ...original, parentPid: 1 }
  const retained = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 123),
  })
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout: ownershipProcessRow(
              original,
              `SUPRASPINA_SMOKE_PROCESS_TOKEN=${ownershipToken}`,
            ),
          }
        }
        if (calls === 2) return { stdout: safeProcessRow(reparented) }
        return {
          stdout: ownershipProcessRow(
            reparented,
            `SUPRASPINA_SMOKE_PROCESS_TOKEN=${ownershipToken}`,
          ),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      readFile: async () => linuxProcessStat(reparented, 123),
      readProcessUserId: async () => 1001,
      requiredPids: new Set([original.pid]),
      retainedRecords: [retained],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
})

test('Linux retained ownership rejects a contradictory O2 effective UID', async () => {
  const ownershipToken = 'fixed-token'
  const original = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: false,
  }
  const reparented = { ...original, parentPid: 1 }
  const contradictory = { ...reparented, userId: 1001 }
  const retained = await processRecord(original, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 123),
  })
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) return { stdout: ownershipProcessRow(original) }
        if (calls === 2) return { stdout: safeProcessRow(reparented) }
        return { stdout: ownershipProcessRow(contradictory) }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      readFile: async () => linuxProcessStat(reparented, 123),
      readProcessUserId: async () => original.userId,
      requiredPids: new Set([original.pid]),
      retainedRecords: [retained],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
})

test('O2 unseen group members veto a retained token group move', async () => {
  const ownershipToken = 'fixed-token'
  const original = {
    command: 'shell',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const moved = {
    ...original,
    command: 'scientific-executable',
    parentPid: 1,
    processGroupId: 78,
    ownershipTokenMatched: false,
  }
  const unseen = {
    command: 'unseen-member',
    parentPid: 1,
    pid: 79,
    processGroupId: moved.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: moved.userId,
    ownershipTokenMatched: false,
  }
  const retained = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 123),
  })
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout: ownershipProcessRow(
              original,
              `SUPRASPINA_SMOKE_PROCESS_TOKEN=${ownershipToken}`,
            ),
          }
        }
        if (calls === 2) return { stdout: safeProcessRow(moved) }
        return {
          stdout:
            ownershipProcessRow(
              moved,
              `SUPRASPINA_SMOKE_PROCESS_TOKEN=${ownershipToken}`,
            ) + ownershipProcessRow(unseen),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      readFile: async () => linuxProcessStat(moved, 123),
      readProcessUserId: async () => original.userId,
      requiredPids: new Set([original.pid]),
      retainedRecords: [retained],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
})

test('markerless durable-token replacement is rejected without a signal', async () => {
  const ownershipToken = 'fixed-token'
  const retainedEntry = {
    command: 'shell',
    parentPid: 100,
    pid: 78,
    processGroupId: 200,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const ownershipEntry = {
    ...retainedEntry,
    command: 'scientific-executable',
    parentPid: 77,
    processGroupId: 77,
    ownershipTokenMatched: false,
  }
  const transitioned = {
    ...ownershipEntry,
    parentPid: 1,
    processGroupId: ownershipEntry.pid,
  }
  const retained = await processRecord(retainedEntry, 1, {
    ownershipBasis: 'token',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(retainedEntry, 777),
  })
  const signals = []
  let calls = 0

  await assert.rejects(
    signalTrackedProcesses(new Map([[retained.key, retained]]), 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownershipToken,
      platform: 'linux',
      readFile: async () => linuxProcessStat(transitioned, 888),
      readProcessTable: () =>
        readProcessTable({
          access: async () => undefined,
          execFile: async () => {
            calls += 1
            if (calls === 1) {
              return { stdout: ownershipProcessRow(ownershipEntry) }
            }
            if (calls === 2) return { stdout: safeProcessRow(transitioned) }
            return { stdout: ownershipProcessRow(transitioned) }
          },
          lstat: async () => ({ isFile: () => true }),
          ownershipToken,
          platform: 'linux',
          readFile: async () => linuxProcessStat(transitioned, 888),
          requiredPids: new Set([retained.pid]),
          retainedRecords: [retained],
        }),
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
  assert.deepEqual(signals, [])
})

test('same-second PID reuse cannot inherit a prior token or be signaled', async () => {
  const ownershipToken = 'fixed-token'
  const original = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const replacement = {
    ...original,
    command: 'unrelated-process',
    parentPid: 1,
    processGroupId: 78,
    ownershipTokenMatched: false,
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 123),
  })
  const observed = new Map([[record.key, record]])
  const signals = []
  let calls = 0

  await assert.rejects(
    signalTrackedProcesses(observed, 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownershipToken,
      platform: 'linux',
      readFile: async () => linuxProcessStat(replacement, 456),
      readProcessTable: () =>
        readProcessTable({
          access: async () => undefined,
          execFile: async () => {
            calls += 1
            if (calls === 1) {
              return {
                stdout: ownershipProcessRow(
                  original,
                  `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
                ),
              }
            }
            if (calls === 2) {
              return { stdout: safeProcessRow(replacement) }
            }
            return { stdout: ownershipProcessRow(replacement) }
          },
          lstat: async () => ({ isFile: () => true }),
          ownershipToken,
          platform: 'linux',
          requiredPids: new Set([original.pid]),
          retainedRecords: [record],
        }),
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
  assert.deepEqual(signals, [])
})

test('ownership capture preserves a descendant during token transition', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-parent',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
  }
  const child = {
    command: 'new-child',
    parentPid: required.pid,
    pid: 78,
    processGroupId: required.processGroupId,
    userId: required.userId,
  }
  const drifted = {
    ...required,
    parentPid: 2,
  }
  let calls = 0

  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async () => {
      calls += 1
      if (calls === 1) {
        return {
          stdout: ownershipProcessRow(
            required,
            `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
          ),
        }
      }
      if (calls === 3) {
        return {
          stdout:
            ownershipProcessRow(
              drifted,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ) + ownershipProcessRow(child),
        }
      }
      return {
        stdout: safeProcessRow(drifted) + safeProcessRow(child),
      }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
    requiredPids: new Set([required.pid]),
    retainedRecords: [
      {
        ownershipBasis: 'token',
        pid: required.pid,
        startedAt: required.startedAt,
        userId: required.userId,
      },
    ],
  })

  assert.equal(calls, 3)
  assert.deepEqual(
    rows.map((entry) => [entry.pid, entry.ownershipTokenMatched]),
    [
      [required.pid, true],
      [child.pid, false],
    ],
  )
})

test('O2 cannot contradict a stable token marker', async () => {
  const ownershipToken = 'fixed-token'
  const root = {
    command: 'tracked-parent',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const child = {
    command: 'tracked-child',
    parentPid: root.pid,
    pid: 78,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const reparented = { ...child, parentPid: 1 }
  const rootRecord = await processRecord(root, 1, {
    ownershipBasis: 'token',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(root, 100),
  })
  const childRecord = await processRecord(child, 2, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(child, 200),
  })
  const marker = `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout:
              ownershipProcessRow(root, marker) + ownershipProcessRow(child),
          }
        }
        if (calls === 2) {
          return { stdout: safeProcessRow(root) + safeProcessRow(reparented) }
        }
        return {
          stdout: ownershipProcessRow(root) + ownershipProcessRow(reparented),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      readFile: async () => linuxProcessStat(reparented, 200),
      requiredPids: new Set([root.pid, child.pid]),
      retainedRecords: [rootRecord, childRecord],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
})

test('O2 rejects a contradictory replacement for an S-only child', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-parent',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
  }
  const transitioned = { ...required, parentPid: 2 }
  const child = {
    command: 'new-child',
    parentPid: required.pid,
    pid: 78,
    processGroupId: required.processGroupId,
    userId: required.userId,
  }
  const replacement = {
    ...child,
    command: 'unrelated',
    parentPid: 1,
    processGroupId: child.pid,
  }
  const marker = `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return { stdout: ownershipProcessRow(required, marker) }
        }
        if (calls === 2) {
          return {
            stdout: safeProcessRow(transitioned) + safeProcessRow(child),
          }
        }
        return {
          stdout:
            ownershipProcessRow(transitioned, marker) +
            ownershipProcessRow(replacement),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      requiredPids: new Set([required.pid]),
      retainedRecords: [
        {
          ownershipBasis: 'token',
          pid: required.pid,
          startedAt: required.startedAt,
          userId: required.userId,
        },
      ],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
})

test('O2 omission cannot return stale S-only child evidence', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-parent',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
  }
  const transitioned = { ...required, parentPid: 2 }
  const child = {
    command: 'new-child',
    parentPid: required.pid,
    pid: 78,
    processGroupId: required.processGroupId,
    userId: required.userId,
  }
  const marker = `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`
  let calls = 0

  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async () => {
      calls += 1
      if (calls === 1) {
        return { stdout: ownershipProcessRow(required, marker) }
      }
      if (calls === 2) {
        return {
          stdout: safeProcessRow(transitioned) + safeProcessRow(child),
        }
      }
      return { stdout: ownershipProcessRow(transitioned, marker) }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
    requiredPids: new Set([required.pid]),
    retainedRecords: [
      {
        ownershipBasis: 'token',
        pid: required.pid,
        startedAt: required.startedAt,
        userId: required.userId,
      },
    ],
  })

  assert.equal(calls, 3)
  assert.deepEqual(
    rows.map((entry) => entry.pid),
    [required.pid],
  )
})

test('ownership confirmation cannot discard a newly token-owned child', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-parent',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
  }
  const transitioned = {
    ...required,
    parentPid: 2,
  }
  const child = {
    command: 'new-child',
    parentPid: transitioned.pid,
    pid: 78,
    processGroupId: transitioned.processGroupId,
    userId: required.userId,
  }
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout: ownershipProcessRow(
              required,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ),
          }
        }
        if (calls === 2) {
          return { stdout: safeProcessRow(transitioned) }
        }
        return {
          stdout:
            ownershipProcessRow(
              transitioned,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ) +
            ownershipProcessRow(
              child,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      requiredPids: new Set([required.pid]),
      retainedRecords: [
        {
          ownershipBasis: 'token',
          pid: required.pid,
          startedAt: required.startedAt,
          userId: required.userId,
        },
      ],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
})

test('ownership capture rejects an ambiguous child in a transitioned group', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-parent',
    parentPid: 1,
    pid: 77,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
  }
  const transitioned = {
    ...required,
    processGroupId: 88,
  }
  const child = {
    command: 'new-child',
    parentPid: 1,
    pid: 78,
    processGroupId: transitioned.processGroupId,
    userId: required.userId,
  }
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout: ownershipProcessRow(
              required,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ),
          }
        }
        if (calls === 3) {
          return {
            stdout: ownershipProcessRow(
              transitioned,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ),
          }
        }
        return {
          stdout: safeProcessRow(transitioned) + safeProcessRow(child),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      requiredPids: new Set([required.pid]),
      retainedRecords: [
        {
          ownershipBasis: 'token',
          pid: required.pid,
          startedAt: required.startedAt,
          userId: required.userId,
        },
      ],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 2)
})

test('ownership capture rejects metadata drift for a required process', async () => {
  const required = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
  }
  const drifted = {
    ...required,
    parentPid: 1,
  }
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        return {
          stdout:
            calls === 1
              ? ownershipProcessRow(required)
              : safeProcessRow(drifted),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      platform: 'linux',
      requiredPids: new Set([required.pid]),
      retainedRecords: [
        {
          ownershipBasis: 'ancestry',
          pid: required.pid,
          startedAt: required.startedAt,
          userId: required.userId,
        },
      ],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 2)
})

test('ownership capture reconciles only an exact retained Linux ancestry reparent', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: false,
  }
  const reparented = { ...required, parentPid: 1 }
  const retained = await processRecord(required, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(required, 123),
  })
  let calls = 0

  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async () => {
      calls += 1
      if (calls === 1) return { stdout: ownershipProcessRow(required) }
      if (calls === 2) return { stdout: safeProcessRow(reparented) }
      return { stdout: ownershipProcessRow(reparented) }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(reparented, 123),
    requiredPids: new Set([required.pid]),
    retainedRecords: [retained],
  })

  assert.equal(calls, 3)
  assert.deepEqual(rows, [
    {
      command: required.command,
      ownershipTokenMatched: false,
      parentPid: reparented.parentPid,
      pid: required.pid,
      processGroupId: required.processGroupId,
      startedAt: required.startedAt,
      userId: required.userId,
    },
  ])
})

test('ancestry reparent keeps its original retained edge evidence', async () => {
  const ownershipToken = 'fixed-token'
  const retainedEdge = {
    command: 'tracked-child',
    parentPid: 55,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: false,
  }
  const ownershipEntry = { ...retainedEdge, parentPid: 77 }
  const reparented = { ...retainedEdge, parentPid: 1 }
  const retained = await processRecord(retainedEdge, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(retainedEdge, 123),
  })
  let calls = 0

  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async () => {
      calls += 1
      if (calls === 1) return { stdout: ownershipProcessRow(ownershipEntry) }
      if (calls === 2) return { stdout: safeProcessRow(reparented) }
      return { stdout: ownershipProcessRow(reparented) }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(reparented, 123),
    requiredPids: new Set([ownershipEntry.pid]),
    retainedRecords: [retained],
  })

  assert.equal(calls, 3)
  assert.equal(rows[0].parentPid, reparented.parentPid)
  assert.equal(retained.parentPid, retainedEdge.parentPid)
})

test('retained ancestry is not upgraded when its current marker is visible', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: false,
  }
  const reparented = { ...required, parentPid: 1 }
  const marker = `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`
  const retained = await processRecord(required, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(required, 123),
  })
  let calls = 0

  const rows = await readProcessTable({
    access: async () => undefined,
    execFile: async () => {
      calls += 1
      if (calls === 1) {
        return { stdout: ownershipProcessRow(required, marker) }
      }
      if (calls === 2) return { stdout: safeProcessRow(reparented) }
      return { stdout: ownershipProcessRow(reparented, marker) }
    },
    lstat: async () => ({ isFile: () => true }),
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(reparented, 123),
    requiredPids: new Set([required.pid]),
    retainedRecords: [retained],
  })

  assert.equal(calls, 3)
  assert.equal(rows[0].ownershipTokenMatched, false)
})

test('ancestry reparent PID replacement is rejected without a signal', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: false,
  }
  const reparented = { ...required, parentPid: 1 }
  const retained = await processRecord(required, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(required, 123),
  })
  const observed = new Map([[retained.key, retained]])
  const signals = []
  let calls = 0

  await assert.rejects(
    signalTrackedProcesses(observed, 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownershipToken,
      platform: 'linux',
      readFile: async () => linuxProcessStat(reparented, 456),
      readProcessTable: () =>
        readProcessTable({
          access: async () => undefined,
          execFile: async () => {
            calls += 1
            if (calls === 1) {
              return { stdout: ownershipProcessRow(required) }
            }
            if (calls === 2) {
              return { stdout: safeProcessRow(reparented) }
            }
            return { stdout: ownershipProcessRow(reparented) }
          },
          lstat: async () => ({ isFile: () => true }),
          ownershipToken,
          platform: 'linux',
          readFile: async () => linuxProcessStat(reparented, 456),
          requiredPids: new Set([required.pid]),
          retainedRecords: [retained],
        }),
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
  assert.deepEqual(signals, [])
})

test('ancestry reparent reconciliation cannot discard an O1 descendant', async () => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-parent',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: false,
  }
  const child = {
    command: 'tracked-child',
    parentPid: required.pid,
    pid: 79,
    processGroupId: required.processGroupId,
    userId: required.userId,
  }
  const reparented = { ...required, parentPid: 1 }
  const retained = await processRecord(required, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(required, 123),
  })
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout: ownershipProcessRow(required) + ownershipProcessRow(child),
          }
        }
        if (calls === 2) return { stdout: safeProcessRow(reparented) }
        return { stdout: ownershipProcessRow(reparented) }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      readFile: async () => linuxProcessStat(reparented, 123),
      requiredPids: new Set([required.pid]),
      retainedRecords: [retained],
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 3)
})

test('ancestry reconciliation accepts exact Linux lifetime transitions', async (t) => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: false,
  }
  const retained = await processRecord(required, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(required, 123),
  })
  const variants = {
    'the command transition': [
      { ...required, parentPid: 1, command: 'replacement' },
      'linux',
    ],
  }

  for (const [name, [changed, platform]] of Object.entries(variants)) {
    await t.test(name, async () => {
      let calls = 0
      const rows = await readProcessTable({
        access: async () => undefined,
        execFile: async () => {
          calls += 1
          return {
            stdout:
              calls === 1
                ? ownershipProcessRow(required)
                : calls === 2
                  ? safeProcessRow(changed)
                  : ownershipProcessRow(changed),
          }
        },
        lstat: async () => ({ isFile: () => true }),
        ownershipToken,
        platform,
        readFile: async () => linuxProcessStat(changed, 123),
        requiredPids: new Set([required.pid]),
        retainedRecords: [retained],
      })

      assert.equal(calls, 3)
      assert.equal(rows[0].parentPid, changed.parentPid)
      assert.equal(rows[0].processGroupId, changed.processGroupId)
      assert.equal(rows[0].ownershipTokenMatched, false)
    })
  }
})

test('ancestry reconciliation rejects replacement identity and Darwin drift', async (t) => {
  const ownershipToken = 'fixed-token'
  const required = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: false,
  }
  const retained = await processRecord(required, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken,
    platform: 'linux',
    readFile: async () => linuxProcessStat(required, 123),
  })
  const variants = {
    'Reject the changed process group.': [
      { ...required, parentPid: 1, processGroupId: 78 },
      'linux',
    ],
    'Reject the changed start time.': [
      {
        ...required,
        parentPid: 1,
        startedAt: 'Thu Jul 23 07:00:01 2026',
      },
      'linux',
    ],
    'Reject the changed user.': [
      { ...required, parentPid: 1, userId: 1001 },
      'linux',
    ],
    'Reject the unsupported Darwin transition.': [
      { ...required, parentPid: 1 },
      'darwin',
    ],
  }

  for (const [name, [changed, platform]] of Object.entries(variants)) {
    await t.test(name, async () => {
      let calls = 0
      await assert.rejects(
        readProcessTable({
          access: async () => undefined,
          execFile: async () => {
            calls += 1
            return {
              stdout:
                calls === 1
                  ? ownershipProcessRow(required)
                  : safeProcessRow(changed),
            }
          },
          lstat: async () => ({ isFile: () => true }),
          ownershipToken,
          platform,
          readFile: async () => linuxProcessStat(changed, 123),
          requiredPids: new Set([required.pid]),
          retainedRecords: [retained],
        }),
        /process-identity-unproved/,
      )
      assert.equal(calls, 2)
    })
  }
})

test('ownership capture rejects malformed rows for an owned process', async () => {
  const ownershipToken = 'fixed-token'
  const processEntry = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    userId: 1000,
  }
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout: ownershipProcessRow(
              processEntry,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ),
          }
        }
        return { stdout: `${processEntry.pid} malformed safe row\n` }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 2)
})

test('ownership capture rejects duplicate process rows', async () => {
  const ownershipToken = 'fixed-token'
  const processEntry = {
    command: 'tracked-child',
    parentPid: 77,
    pid: 78,
    processGroupId: 77,
    userId: 1000,
  }
  let calls = 0

  await assert.rejects(
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout: ownershipProcessRow(
              processEntry,
              `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`,
            ),
          }
        }
        const row = safeProcessRow(processEntry)
        return { stdout: row + row }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
    }),
    /process-identity-unproved/,
  )

  assert.equal(calls, 2)
})

test('recursive user-data cleanup has a fixed time bound', async () => {
  const startedAt = Date.now()

  await assert.rejects(
    removeUserDataDirectory('/fixed/test/path', {
      rm: async () => new Promise(() => undefined),
      timeoutMs: 20,
    }),
    /user-data-cleanup-timeout/,
  )

  assert.ok(Date.now() - startedAt < 1_000)
})

test('root exit is proved without waiting for inherited stdio closure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'supraspina-root-exit-'))
  const pidFile = join(directory, 'descendant.pid')
  const root = spawn(
    process.execPath,
    [
      '-e',
      String.raw`
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const descendant = spawn(
  process.execPath,
  ['-e', 'setTimeout(() => undefined, 30000)'],
  { stdio: ['ignore', 1, 2] },
)
descendant.unref()
writeFileSync(process.argv[1], String(descendant.pid), 'ascii')
`,
      pidFile,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let closeSettled = false
  const closed = new Promise((resolveClose) => {
    root.once('close', () => {
      closeSettled = true
      resolveClose()
    })
  })
  let descendantPid = null

  try {
    await waitForChildExit(root, 2_000)
    descendantPid = Number(readFileSync(pidFile, 'ascii'))
    assert.equal(root.exitCode, 0)
    assert.equal(root.signalCode, null)
    assert.equal(Number.isSafeInteger(descendantPid), true)
    assert.equal(closeSettled, false)

    process.kill(descendantPid, 'SIGTERM')
    await Promise.race([
      closed,
      new Promise((_, rejectClose) => {
        const timer = setTimeout(
          () => rejectClose(new Error('Close stdio before the timeout.')),
          2_000,
        )
        timer.unref()
      }),
    ])
    assert.equal(closeSettled, true)
  } finally {
    if (Number.isSafeInteger(descendantPid)) {
      try {
        process.kill(descendantPid, 'SIGKILL')
      } catch {
        // The descendant already exited; there is nothing left to signal.
      }
    }
    root.kill('SIGKILL')
    root.stdout?.destroy()
    root.stderr?.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test('root exit proof has a deterministic timeout', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null

  await assert.rejects(waitForChildExit(child, 20), /electron-exit-timeout/)
})

test('spawn proof rejects a failed launch without an unsafe PID', async () => {
  const child = new EventEmitter()
  child.pid = undefined
  const spawned = waitForChildSpawn(child, 1_000)

  child.emit('error', new Error('Raise the fixed fixture failure.'))

  await assert.rejects(spawned, /electron-launch-failed/)
})

test('harness signals own the root group and tracked detached processes', async () => {
  const runtime = new EventEmitter()
  const child = { pid: 4242 }
  const rootSignals = []
  const trackedSignals = []
  const observed = new Map([['owned', { pid: 4343 }]])
  const handlers = installHarnessSignalHandlers(child, () => observed, {
    runtime,
    signalRoot: (_child, signal) => rootSignals.push(signal),
    signalObserved: async (records, signal) => {
      trackedSignals.push([records, signal])
    },
  })

  runtime.emit('SIGTERM')
  await Promise.resolve()

  assert.equal(handlers.interrupted(), true)
  assert.deepEqual(rootSignals, ['SIGTERM'])
  assert.deepEqual(trackedSignals, [[observed, 'SIGTERM']])
  handlers.dispose()
  assert.equal(runtime.listenerCount('SIGINT'), 0)
  assert.equal(runtime.listenerCount('SIGTERM'), 0)
  assert.equal(runtime.listenerCount('SIGHUP'), 0)
})

test('the tracker records ownership before an initial process-table failure', async () => {
  const tracker = startProcessTracker(42, {
    readProcessTable: async () => {
      throw new Error('Treat the process table as unavailable.')
    },
  })

  assert.equal(typeof tracker.snapshot, 'function')
  await assert.rejects(tracker.ready, /process table as unavailable/)
  await assert.rejects(tracker.stop(), /process-tracking-failed/)
})

test('the tracker coalesces slow samples instead of queuing an unbounded backlog', async () => {
  const row = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'observed',
    ownershipTokenMatched: true,
  }
  let concurrent = 0
  let maximumConcurrent = 0
  const tracker = startProcessTracker(42, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    pollIntervalMs: 5,
    readProcessTable: async () => {
      concurrent += 1
      maximumConcurrent = Math.max(maximumConcurrent, concurrent)
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
      concurrent -= 1
      return [row]
    },
  })

  await tracker.ready
  await new Promise((resolveWait) => setTimeout(resolveWait, 110))
  const stopStartedAt = Date.now()
  await tracker.stop()

  assert.equal(maximumConcurrent, 1)
  assert.ok(Date.now() - stopStartedAt < 200)
})

test('the tracker retries one unchanged incoherent Linux snapshot', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const changed = { ...root, parentPid: 999 }
  const unrelated = {
    command: 'unrelated',
    parentPid: 1,
    pid: 900,
    processGroupId: 900,
    startedAt: 'Thu Jul 23 06:00:00 2026',
    userId: 2000,
    ownershipTokenMatched: false,
  }
  let rejectedIdentityReadsRemaining = 0
  let rejectedIdentities = 0
  let tableReads = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async () => {
      if (rejectedIdentityReadsRemaining > 0) {
        rejectedIdentityReadsRemaining -= 1
        rejectedIdentities += 1
        return linuxProcessStat(changed, 100)
      }
      return linuxProcessStat(root, 100)
    },
    readProcessTable: async () => {
      tableReads += 1
      return [root, unrelated]
    },
  })

  await tracker.ready
  rejectedIdentityReadsRemaining = 2
  await tracker.stop()

  assert.equal(rejectedIdentities, 2)
  assert.equal(tableReads, 3)
})

test('the tracker never retries away a newly escaped descendant', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const escaped = {
    command: 'escaped-child',
    parentPid: root.pid,
    pid: 43,
    processGroupId: 43,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const changed = { ...root, command: 'replacement' }
  let afterReady = false
  let postReadyScans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      if (afterReady && pid === root.pid) {
        return linuxProcessStat(changed, 100)
      }
      return linuxProcessStat(pid === root.pid ? root : escaped, 100 + pid)
    },
    readProcessTable: async () => {
      if (!afterReady) return [root]
      postReadyScans += 1
      return postReadyScans === 1 ? [root, escaped] : []
    },
  })

  await tracker.ready
  afterReady = true
  await assert.rejects(tracker.stop(), /process-identity-unproved/)

  assert.equal(postReadyScans, 1)
})

test('the tracker never retries away a new retained-group member', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const groupMember = {
    command: 'new-group-member',
    parentPid: 1,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const changed = { ...root, command: 'replacement' }
  let afterReady = false
  let postReadyScans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      if (afterReady && pid === root.pid) {
        return linuxProcessStat(changed, 100)
      }
      return linuxProcessStat(pid === root.pid ? root : groupMember, 100 + pid)
    },
    readProcessTable: async () => {
      if (!afterReady) return [root]
      postReadyScans += 1
      return postReadyScans === 1 ? [root, groupMember] : []
    },
  })

  await tracker.ready
  afterReady = true
  await assert.rejects(tracker.stop(), /process-identity-unproved/)

  assert.equal(postReadyScans, 1)
})

test('anchored Linux group sweep retains a member after its leader exits', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const member = {
    command: 'group-member',
    parentPid: 1,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  let rows = [root, member]
  const tracker = startProcessTracker(root.pid, {
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      return linuxProcessStat(pid === root.pid ? root : member, 100 + pid)
    },
    readProcessTable: async () => rows,
  })

  await tracker.ready
  assert.equal(
    [...tracker.snapshot().values()].some(
      (record) =>
        record.pid === member.pid && record.ownershipBasis === 'ancestry',
    ),
    true,
  )

  rows = [member]
  const observed = await tracker.stop()
  assert.equal(
    [...observed.values()].some((record) => record.pid === member.pid),
    true,
  )
})

test('new token exec transition is quarantined until the same lifetime is coherent', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const staleChild = {
    pid: 43,
    parentPid: root.pid,
    processGroupId: 43,
    userId: root.userId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'electron',
    ownershipTokenMatched: true,
  }
  const currentChild = { ...staleChild, command: 'scientific-helper' }
  let afterReady = false
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      const entry = pid === root.pid ? root : currentChild
      return linuxProcessStat(entry, 100 + pid)
    },
    readProcessTable: async () => {
      if (!afterReady) return [root]
      scans += 1
      return scans === 1 ? [root, staleChild] : [root, currentChild]
    },
  })

  await tracker.ready
  afterReady = true
  const observed = await tracker.stop()

  assert.equal(scans, 2)
  assert.equal(
    [...observed.values()].some(
      (record) =>
        record.pid === currentChild.pid && record.ownershipBasis === 'token',
    ),
    true,
  )
})

test('new token exec transition cannot be retried away after marker loss', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const staleChild = {
    pid: 43,
    parentPid: root.pid,
    processGroupId: 43,
    userId: root.userId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'electron',
    ownershipTokenMatched: true,
  }
  const escapedChild = {
    ...staleChild,
    command: 'scientific-helper',
    ownershipTokenMatched: false,
  }
  let afterReady = false
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 20,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      const entry = pid === root.pid ? root : escapedChild
      return linuxProcessStat(entry, 100 + pid)
    },
    readProcessTable: async () => {
      if (!afterReady) return [root]
      scans += 1
      return scans === 1 ? [root, staleChild] : [root]
    },
  })

  await tracker.ready
  afterReady = true
  await assert.rejects(tracker.stop(), /process-identity-unproved/)

  assert.ok(scans > 2)
  assert.equal(
    [...tracker.snapshot().values()].some(
      (record) => record.pid === escapedChild.pid,
    ),
    false,
  )
})

test('initial snapshot quarantines a new token exec transition transactionally', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const staleChild = {
    pid: 43,
    parentPid: root.pid,
    processGroupId: 43,
    userId: root.userId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'electron',
    ownershipTokenMatched: true,
  }
  const currentChild = { ...staleChild, command: 'scientific-helper' }
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      const entry = pid === root.pid ? root : currentChild
      return linuxProcessStat(entry, 100 + pid)
    },
    readProcessTable: async () => {
      scans += 1
      return scans === 1 ? [root, staleChild] : [root, currentChild]
    },
  })

  await tracker.ready

  assert.equal(scans, 2)
  assert.deepEqual(
    [...tracker.snapshot().values()].map((record) => [
      record.pid,
      record.ownershipBasis,
    ]),
    [
      [root.pid, 'token'],
      [currentChild.pid, 'token'],
    ],
  )
  await tracker.stop()
})

test('initial snapshot cannot lose a quarantined token exec transition', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const staleChild = {
    pid: 43,
    parentPid: root.pid,
    processGroupId: 43,
    userId: root.userId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'electron',
    ownershipTokenMatched: true,
  }
  const escapedChild = {
    ...staleChild,
    command: 'scientific-helper',
    ownershipTokenMatched: false,
  }
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 20,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      const entry = pid === root.pid ? root : escapedChild
      return linuxProcessStat(entry, 100 + pid)
    },
    readProcessTable: async () => {
      scans += 1
      return scans === 1 ? [root, staleChild] : [root]
    },
  })

  await assert.rejects(tracker.ready, /process-identity-unproved/)

  assert.ok(scans > 2)
  assert.deepEqual(
    [...tracker.snapshot().values()].map((record) => record.pid),
    [root.pid],
  )
})

test('quarantine clears only after an unproved group identity is dead', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const unproved = {
    command: 'unproved-member',
    parentPid: 1,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  let afterReady = false
  let scans = 0
  let processAlive = true
  const missing = new Error('gone')
  missing.code = 'ENOENT'
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      if (pid === unproved.pid && !processAlive) throw missing
      return linuxProcessStat(pid === root.pid ? root : unproved, 100 + pid)
    },
    readProcessTable: async () => {
      if (!afterReady) return [root]
      scans += 1
      if (scans === 1) return [unproved]
      processAlive = false
      return []
    },
  })

  await tracker.ready
  afterReady = true
  await tracker.stop()

  assert.equal(scans, 2)
  assert.equal(
    [...tracker.snapshot().values()].some(
      (record) => record.pid === unproved.pid,
    ),
    false,
  )
})

test('quarantine follows an unproved identity that moves process groups', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const unproved = {
    command: 'unproved-member',
    parentPid: 1,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const moved = { ...unproved, processGroupId: 99 }
  let afterReady = false
  let scans = 0
  let rows = [root]
  let currentIdentity = unproved
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 20,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      const entry = pid === root.pid ? root : currentIdentity
      return linuxProcessStat(entry, 100 + pid)
    },
    readProcessTable: async () => {
      if (!afterReady) return rows
      scans += 1
      if (scans === 1) {
        currentIdentity = unproved
        rows = [unproved]
      } else if (scans === 2) {
        currentIdentity = moved
        rows = []
      } else {
        currentIdentity = moved
        rows = [moved]
      }
      return rows
    },
  })

  await tracker.ready
  afterReady = true
  await assert.rejects(tracker.stop(), /process-identity-unproved/)

  assert.ok(scans > 2)
  assert.equal(
    [...tracker.snapshot().values()].some(
      (record) => record.pid === unproved.pid,
    ),
    false,
  )
})

test('quarantine requires the same effective UID for the retained lifetime', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const unproved = {
    command: 'unproved-member',
    parentPid: 1,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  let afterReady = false
  let effectiveUserId = root.userId
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      return linuxProcessStat(pid === root.pid ? root : unproved, 100 + pid)
    },
    readProcessTable: async () => {
      if (!afterReady) return [root]
      scans += 1
      if (scans === 1) return [unproved]
      effectiveUserId = 2000
      return []
    },
    readProcessUserId: async () => effectiveUserId,
  })

  await tracker.ready
  afterReady = true
  let cleanupError = null
  let observed
  try {
    observed = await tracker.stop()
  } catch (error) {
    cleanupError = error
    observed = tracker.snapshot()
  }
  const ownedGroups = tracker.groupSnapshot()
  const signals = []
  const absentTable = async () => []

  await signalTrackedProcesses(observed, 'SIGKILL', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownedGroups,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      return linuxProcessStat(pid === root.pid ? root : unproved, 100 + pid)
    },
    readProcessTable: absentTable,
    readProcessUserId: async () => effectiveUserId,
  })
  await waitForProcessesGone(observed, 100, 'orphan-process', {
    ownedGroups,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      return linuxProcessStat(pid === root.pid ? root : unproved, 100 + pid)
    },
    readProcessTable: absentTable,
    readProcessUserId: async () => effectiveUserId,
  })

  assert.match(cleanupError?.message ?? '', /process-identity-unproved/)
  assert.ok(scans > 2)
  assert.equal(effectiveUserId, 2000)
  assert.deepEqual(signals, [])
})

test('persistent reused PGID evidence fails without ownership or a signal', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const replacement = {
    command: 'unrelated',
    parentPid: 1,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  let afterReady = false
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 20,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      return linuxProcessStat(pid === root.pid ? root : replacement, 100 + pid)
    },
    readProcessTable: async () => {
      if (!afterReady) return [root]
      scans += 1
      return [replacement]
    },
  })

  await tracker.ready
  afterReady = true
  await assert.rejects(tracker.stop(), /process-identity-unproved/)
  const signals = []
  await assert.rejects(
    signalTrackedProcesses(tracker.snapshot(), 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownedGroups: tracker.groupSnapshot(),
      ownershipToken: 'fixed-token',
      platform: 'linux',
      readFile: async () => linuxProcessStat(replacement, 143),
      readProcessTable: async () => [replacement],
    }),
    /process-identity-unproved/,
  )

  assert.ok(scans > 1)
  assert.deepEqual(signals, [])
  assert.equal(
    [...tracker.snapshot().values()].some(
      (record) => record.pid === replacement.pid,
    ),
    false,
  )
})

test('ownership marker retains a reparented detached descendant', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'observed',
    ownershipTokenMatched: true,
  }
  const detached = {
    pid: 99,
    parentPid: 1,
    processGroupId: 99,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'observed',
    ownershipTokenMatched: true,
  }
  let samples = 0
  const tracker = startProcessTracker(root.pid, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    pollIntervalMs: 5,
    readProcessTable: async () => {
      samples += 1
      return samples === 1 ? [root] : [detached]
    },
  })

  await tracker.ready
  await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  const observed = await tracker.stop()

  assert.deepEqual(
    [...observed.values()].map((record) => record.pid).sort((a, b) => a - b),
    [42, 99],
  )
})

test('a missing marker permits only exact retained-group signaling', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  let rows = [root]
  const tracker = startProcessTracker(root.pid, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    pollIntervalMs: 10_000,
    readProcessTable: async () => rows,
  })
  await tracker.ready

  rows = [{ ...root, ownershipTokenMatched: false }]
  const signals = []
  await signalTrackedProcesses(tracker.snapshot(), 'SIGTERM', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownedGroups: tracker.groupSnapshot(),
    ownershipToken: 'fixed-token',
    platform: 'darwin',
    readProcessTable: async () => rows,
  })
  await tracker.stop()

  assert.deepEqual(signals, [[-root.processGroupId, 'SIGTERM']])
})

test('a fresh marker refreshes retained group coordinates before disappearing', async () => {
  const root = {
    pid: 42,
    parentPid: 100,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const refreshed = { ...root, parentPid: 200 }
  let rows = [root]
  const tracker = startProcessTracker(root.pid, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    pollIntervalMs: 10_000,
    readProcessTable: async () => rows,
  })
  await tracker.ready

  rows = [refreshed]
  await tracker.adoptAndSignal('SIGTERM', { kill: () => undefined })
  const coordinates = [
    ...tracker.groupSnapshot().get(root.processGroupId).coordinateRecords,
  ]
  rows = [{ ...refreshed, ownershipTokenMatched: false }]
  await tracker.stop()

  assert.equal(coordinates.length, 1)
  assert.equal(coordinates[0].parentPid, refreshed.parentPid)
})

test('the tracker refreshes a live token exec before validating its group', async () => {
  const root = {
    pid: 42,
    parentPid: 100,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  let rows = [root]
  const tracker = startProcessTracker(root.pid, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    pollIntervalMs: 10_000,
    readProcessTable: async () => rows,
  })
  await tracker.ready
  const initialCommandIdentity = tracker
    .groupSnapshot()
    .get(root.processGroupId).leaderRecord.commandIdentity

  rows = [{ ...root, command: 'Electron' }]
  await tracker.stop()
  const refreshedGroup = tracker.groupSnapshot().get(root.processGroupId)

  assert.notEqual(
    refreshedGroup.leaderRecord.commandIdentity,
    initialCommandIdentity,
  )
  assert.equal(refreshedGroup.coordinateRecords.length, 1)
  assert.equal(
    refreshedGroup.coordinateRecords[0].commandIdentity,
    refreshedGroup.leaderRecord.commandIdentity,
  )
})

test('the tracker suppresses only an exact reconciled ancestry PPID drift', async () => {
  const ownershipToken = 'fixed-token'
  const root = {
    command: 'Supraspina',
    parentPid: 1,
    pid: 42,
    processGroupId: 42,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    userId: 1000,
    ownershipTokenMatched: true,
  }
  const child = {
    command: 'tracked-child',
    parentPid: root.pid,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const reparented = { ...child, parentPid: 1 }
  const marker = `${'SUPRASPINA_SMOKE_PROCESS_TOKEN'}=${ownershipToken}`
  let calls = 0
  let tracker
  const loadTable = () =>
    readProcessTable({
      access: async () => undefined,
      execFile: async () => {
        calls += 1
        if (calls === 1) {
          return {
            stdout:
              ownershipProcessRow(root, marker) + ownershipProcessRow(child),
          }
        }
        if (calls === 2) {
          return { stdout: safeProcessRow(root) + safeProcessRow(child) }
        }
        if (calls === 3) {
          return {
            stdout:
              ownershipProcessRow(root, marker) + ownershipProcessRow(child),
          }
        }
        if (calls === 4) {
          return { stdout: safeProcessRow(root) + safeProcessRow(reparented) }
        }
        return {
          stdout:
            ownershipProcessRow(root, marker) + ownershipProcessRow(reparented),
        }
      },
      lstat: async () => ({ isFile: () => true }),
      ownershipToken,
      platform: 'linux',
      readFile: async (path) => {
        const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
        const entry = pid === root.pid ? root : calls >= 3 ? reparented : child
        return linuxProcessStat(entry, pid === root.pid ? 100 : 200)
      },
      requiredPids: new Set(
        tracker
          ? [...tracker.snapshot().values()].map((record) => record.pid)
          : [root.pid],
      ),
      retainedRecords: tracker ? [...tracker.snapshot().values()] : [],
    })
  tracker = startProcessTracker(root.pid, {
    ownershipToken,
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      const entry = pid === root.pid ? root : calls >= 3 ? reparented : child
      return linuxProcessStat(entry, pid === root.pid ? 100 : 200)
    },
    readProcessTable: loadTable,
  })

  await tracker.ready
  const observed = await tracker.stop()
  const retainedChild = [...observed.values()].find(
    (record) => record.pid === child.pid,
  )

  assert.equal(calls, 5)
  assert.equal(retainedChild.parentPid, child.parentPid)
  assert.equal(retainedChild.ownershipBasis, 'ancestry')
  assert.deepEqual([...tracker.groupSnapshot().keys()], [root.processGroupId])
})

test('markerless coordinate drift is unproved and never signaled', async (t) => {
  const root = {
    pid: 42,
    parentPid: 100,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  let rows = [root]
  const tracker = startProcessTracker(root.pid, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    pollIntervalMs: 10_000,
    readProcessTable: async () => rows,
  })
  await tracker.ready

  const variants = {
    'Reject the changed command.': { command: 'replacement' },
    'Reject the changed process group.': { processGroupId: 99 },
    'Reject the changed parent.': { parentPid: 1 },
    'Reject the changed user.': { userId: 501 },
  }
  for (const [name, change] of Object.entries(variants)) {
    await t.test(name, async () => {
      const signals = []
      await assert.rejects(
        signalTrackedProcesses(tracker.snapshot(), 'SIGKILL', {
          kill: (pid, signal) => signals.push([pid, signal]),
          ownedGroups: tracker.groupSnapshot(),
          ownershipToken: 'fixed-token',
          platform: 'darwin',
          readProcessTable: async () => [
            { ...root, ...change, ownershipTokenMatched: false },
          ],
        }),
        /process-identity-unproved/,
      )
      assert.deepEqual(signals, [])
    })
  }

  rows = []
  await tracker.stop()
})

test('root registration retries a transiently missing ownership marker', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: false,
  }
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    readProcessTable: async () => {
      scans += 1
      return [scans === 1 ? root : { ...root, ownershipTokenMatched: true }]
    },
  })

  await tracker.ready
  const observed = await tracker.stop()
  const record = [...observed.values()][0]

  assert.equal(record.pid, root.pid)
  assert.equal(record.ownershipBasis, 'token')
  assert.ok(scans >= 2)
  assert.deepEqual([...tracker.groupSnapshot().keys()], [root.processGroupId])
})

test('token root registration quarantines a transient exec command', async () => {
  const root = {
    pid: 42,
    parentPid: 777,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const staleRoot = { ...root, command: 'electron' }
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    expectedRootOwner: {
      parentPid: root.parentPid,
      processGroupId: root.processGroupId,
      userId: root.userId,
    },
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(root, 142),
    readProcessTable: async () => {
      scans += 1
      return [scans === 1 ? staleRoot : root]
    },
  })

  await tracker.ready
  const record = [...tracker.snapshot().values()][0]

  assert.equal(scans, 2)
  assert.equal(record.pid, root.pid)
  assert.equal(record.startIdentity, 'linux:142')
  assert.equal(record.ownershipBasis, 'token')
  await tracker.stop()
})

test('initial post-registration root reparent is quarantined transactionally', async () => {
  const root = {
    pid: 42,
    parentPid: 777,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const reparented = { ...root, parentPid: 1 }
  let identityReads = 0
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    expectedRootOwner: {
      parentPid: root.parentPid,
      processGroupId: root.processGroupId,
      userId: root.userId,
    },
    identityRetryDelayMs: 1,
    identityRetryTimeoutMs: 100,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async () => {
      identityReads += 1
      return linuxProcessStat(identityReads <= 2 ? root : reparented, 142)
    },
    readProcessTable: async () => {
      scans += 1
      return [scans === 1 ? root : reparented]
    },
  })

  await tracker.ready

  assert.equal(scans, 2)
  assert.equal(
    [...tracker.groupSnapshot().values()][0].anchorRecords[0].parentPid,
    reparented.parentPid,
  )
  assert.deepEqual(tracker.quarantineSnapshot(), [])
  await tracker.stop()
})

test('token root exec quarantine cannot downgrade after marker loss', async () => {
  const root = {
    pid: 42,
    parentPid: 777,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const staleRoot = { ...root, command: 'electron' }
  const markerlessRoot = { ...root, ownershipTokenMatched: false }
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    expectedRootOwner: {
      parentPid: root.parentPid,
      processGroupId: root.processGroupId,
      userId: root.userId,
    },
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(root, 142),
    readProcessTable: async () => {
      scans += 1
      return [scans === 1 ? staleRoot : markerlessRoot]
    },
    rootRegistrationTimeoutMs: 30,
  })

  await assert.rejects(tracker.ready, /process-identity-unproved/)

  assert.ok(scans >= 2)
  assert.equal(tracker.snapshot().size, 0)
})

test('token root replacement is never committed or signaled after marker loss', async () => {
  const root = {
    pid: 42,
    parentPid: 777,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const staleRoot = { ...root, command: 'electron' }
  const replacement = {
    ...root,
    command: 'replacement',
    ownershipTokenMatched: true,
  }
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    expectedRootOwner: {
      parentPid: root.parentPid,
      processGroupId: root.processGroupId,
      userId: root.userId,
    },
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () =>
      linuxProcessStat(
        scans === 1 ? root : replacement,
        scans === 1 ? 142 : 999,
      ),
    readProcessTable: async () => {
      scans += 1
      return [scans === 1 ? staleRoot : replacement]
    },
    rootRegistrationTimeoutMs: 100,
  })

  await assert.rejects(tracker.ready, /process-identity-unproved/)

  const observed = tracker.snapshot()
  const signals = []
  await signalTrackedProcesses(observed, 'SIGKILL', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(replacement, 999),
    readProcessTable: async () => [
      { ...replacement, ownershipTokenMatched: false },
    ],
  })

  assert.equal(observed.size, 0)
  assert.deepEqual(signals, [])
})

test('markerless root requires stable exact direct-spawn coordinates', async () => {
  const root = {
    pid: 42,
    parentPid: 777,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: false,
  }
  const tracker = startProcessTracker(root.pid, {
    expectedRootOwner: {
      parentPid: root.parentPid,
      processGroupId: root.processGroupId,
      userId: root.userId,
    },
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    readProcessTable: async () => [root],
  })

  await tracker.ready
  const observed = await tracker.stop()
  const record = [...observed.values()][0]

  assert.equal(record.pid, root.pid)
  assert.equal(record.ownershipBasis, 'ancestry')
})

test('same-snapshot ancestry admits a markerless setsid descendant', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'observed',
    ownershipTokenMatched: true,
  }
  const bridge = {
    pid: 43,
    parentPid: 42,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'observed',
    ownershipTokenMatched: false,
  }
  const escaped = {
    pid: 99,
    parentPid: 43,
    processGroupId: 99,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'observed',
    ownershipTokenMatched: false,
  }
  const tracker = startProcessTracker(root.pid, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    readProcessTable: async () => [root, bridge, escaped],
  })

  await tracker.ready
  const observed = await tracker.stop()
  const byPid = new Map(
    [...observed.values()].map((record) => [record.pid, record]),
  )

  assert.equal(byPid.get(root.pid)?.ownershipBasis, 'token')
  assert.equal(byPid.get(bridge.pid)?.ownershipBasis, 'ancestry')
  assert.equal(byPid.get(escaped.pid)?.ownershipBasis, 'ancestry')
  assert.equal('command' in byPid.get(escaped.pid), false)
  assert.deepEqual(
    [...tracker.groupSnapshot().keys()].sort((a, b) => a - b),
    [42, 99],
  )
})

test('new Linux ancestry child adopts an authoritative post-exec comm', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const child = {
    command: 'shell',
    parentPid: root.pid,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const executed = { ...child, command: 'scientific-executable' }
  let rows = [root]
  const tracker = startProcessTracker(root.pid, {
    identityKey: 'fixed-identity-key',
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      return linuxProcessStat(pid === root.pid ? root : executed, 100 + pid)
    },
    readProcessTable: async () => rows,
  })
  const stale = await processRecord(child, 1, {
    identityKey: 'fixed-identity-key',
    ownershipBasis: 'ancestry',
    platform: 'linux',
    readFile: async () => linuxProcessStat(child, 143),
  })

  await tracker.ready
  rows = [root, child]
  const observed = await tracker.stop()
  const adopted = [...observed.values()].find(
    (record) => record.pid === child.pid,
  )

  assert.equal(adopted?.ownershipBasis, 'ancestry')
  assert.notEqual(adopted?.commandIdentity, stale.commandIdentity)
})

test('Linux ancestry PID reuse with changed start ticks is never readopted', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const child = {
    command: 'child',
    parentPid: root.pid,
    pid: 43,
    processGroupId: root.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: root.userId,
    ownershipTokenMatched: false,
  }
  const replacement = { ...child, command: 'replacement', parentPid: 1 }
  let replaced = false
  const tracker = startProcessTracker(root.pid, {
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: async (path) => {
      const pid = Number(path.match(/\/proc\/(\d+)\/stat$/)?.[1])
      if (pid === root.pid) return linuxProcessStat(root, 142)
      return linuxProcessStat(
        replaced ? replacement : child,
        replaced ? 999 : 143,
      )
    },
    readProcessTable: async () => [root, replaced ? replacement : child],
  })

  await tracker.ready
  replaced = true
  await assert.rejects(tracker.stop(), /process-identity-unproved/)

  assert.equal(
    [...tracker.snapshot().values()].filter(
      (record) => record.pid === child.pid,
    ).length,
    1,
  )
})

test('first ancestry adoption cannot be upgraded by a later token scan', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'root',
    ownershipTokenMatched: true,
  }
  const child = {
    pid: 43,
    parentPid: 42,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'helper',
    ownershipTokenMatched: false,
  }
  let scans = 0
  const tracker = startProcessTracker(root.pid, {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    readProcessTable: async () => {
      scans += 1
      return scans === 1
        ? [root, child]
        : [root, { ...child, ownershipTokenMatched: true }]
    },
  })

  await tracker.ready
  const observed = await tracker.stop()
  const childRecords = [...observed.values()].filter(
    (record) => record.pid === child.pid,
  )

  assert.equal(childRecords.length, 1)
  assert.equal(childRecords[0].ownershipBasis, 'ancestry')
})

test('same-second Darwin replacement is unproved and is never signaled', async () => {
  const original = {
    pid: 99,
    parentPid: 42,
    processGroupId: 99,
    userId: 501,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'original-helper',
    ownershipTokenMatched: false,
  }
  const replacement = {
    ...original,
    command: 'replacement-helper',
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const observed = new Map([[record.key, record]])
  const signals = []

  await assert.rejects(
    signalTrackedProcesses(observed, 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownershipToken: 'fixed-token',
      platform: 'darwin',
      readProcessTable: async () => [replacement],
    }),
    /process-identity-unproved/,
  )
  assert.deepEqual(signals, [])
})

test('ancestry metadata drift remains unproved instead of looking dead', async () => {
  const original = {
    pid: 99,
    parentPid: 42,
    processGroupId: 99,
    userId: 501,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'helper',
    ownershipTokenMatched: false,
  }
  const drifted = { ...original, parentPid: 1 }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const observed = new Map([[record.key, record]])

  await assert.rejects(
    waitForProcessesGone(observed, 100, 'orphan-process', {
      ownershipToken: 'fixed-token',
      platform: 'darwin',
      readProcessTable: async () => [drifted],
    }),
    /process-identity-unproved/,
  )
})

test('owned group survives leader exit while an exact member remains', async () => {
  const leader = {
    pid: 99,
    parentPid: 42,
    processGroupId: 99,
    userId: 501,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'leader',
    ownershipTokenMatched: false,
  }
  const member = {
    pid: 100,
    parentPid: 99,
    processGroupId: 99,
    userId: 501,
    startedAt: 'Thu Jul 23 07:00:03 2026',
    command: 'member',
    ownershipTokenMatched: false,
  }
  const leaderRecord = await processRecord(leader, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const memberRecord = await processRecord(member, 2, {
    ownershipBasis: 'ancestry',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const observed = new Map([
    [leaderRecord.key, leaderRecord],
    [memberRecord.key, memberRecord],
  ])
  const ownedGroups = new Map([
    [
      99,
      {
        processGroupId: 99,
        leaderRecord,
        memberKeys: [leaderRecord.key, memberRecord.key],
      },
    ],
  ])
  const signals = []
  let scans = 0

  await waitForProcessesGone(observed, 1_000, 'orphan-process', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownedGroups,
    ownershipToken: 'fixed-token',
    platform: 'darwin',
    readProcessTable: async () => {
      scans += 1
      return scans <= 2 ? [member] : []
    },
    signal: 'SIGKILL',
  })

  assert.deepEqual(signals, [
    [member.pid, 'SIGKILL'],
    [-leader.processGroupId, 'SIGKILL'],
  ])
})

test('reused process-group identity is never sent a negative-PGID signal', async () => {
  const original = {
    pid: 99,
    parentPid: 42,
    processGroupId: 99,
    userId: 501,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'leader',
    ownershipTokenMatched: false,
  }
  const replacement = {
    ...original,
    parentPid: 1,
    startedAt: 'Thu Jul 23 07:00:03 2026',
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const observed = new Map([[record.key, record]])
  const ownedGroups = new Map([
    [
      original.processGroupId,
      {
        processGroupId: original.processGroupId,
        leaderRecord: record,
        memberKeys: [record.key],
      },
    ],
  ])
  const signals = []

  await waitForProcessesGone(observed, 100, 'orphan-process', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownedGroups,
    ownershipToken: 'fixed-token',
    platform: 'darwin',
    readProcessTable: async () => [replacement],
    signal: 'SIGKILL',
  })

  assert.deepEqual(signals, [])
})

test('same-second Darwin token-leader replacement cannot claim its old group', async () => {
  const original = {
    pid: 99,
    parentPid: 42,
    processGroupId: 99,
    userId: 501,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'group-leader',
    ownershipTokenMatched: true,
  }
  const replacement = {
    ...original,
    ownershipTokenMatched: false,
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const observed = new Map([[record.key, record]])
  const ownedGroups = new Map([
    [
      original.processGroupId,
      {
        processGroupId: original.processGroupId,
        leaderRecord: record,
        memberKeys: [],
      },
    ],
  ])
  const signals = []

  await assert.rejects(
    signalTrackedProcesses(observed, 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownedGroups,
      ownershipToken: 'fixed-token',
      platform: 'darwin',
      readProcessTable: async () => [replacement],
    }),
    /process-identity-unproved/,
  )
  assert.deepEqual(signals, [])
})

test('same-second Darwin ancestry replacement cannot claim its old group', async () => {
  const original = {
    pid: 99,
    parentPid: 42,
    processGroupId: 99,
    userId: 501,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'group-leader',
    ownershipTokenMatched: false,
  }
  const replacement = {
    ...original,
    parentPid: 1,
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'ancestry',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const observed = new Map([[record.key, record]])
  const ownedGroups = new Map([
    [
      original.processGroupId,
      {
        processGroupId: original.processGroupId,
        leaderRecord: record,
        memberKeys: [record.key],
      },
    ],
  ])
  const signals = []

  await assert.rejects(
    signalTrackedProcesses(observed, 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownedGroups,
      ownershipToken: 'fixed-token',
      platform: 'darwin',
      readProcessTable: async () => [replacement],
    }),
    /process-identity-unproved/,
  )
  assert.deepEqual(signals, [])
})

test('post-stop proof adopts and signals a late token-owned process', async () => {
  const late = {
    pid: 99,
    parentPid: 1,
    processGroupId: 99,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'observed',
    ownershipTokenMatched: true,
  }
  const observed = new Map()
  const signals = []
  let scans = 0

  await waitForProcessesGone(observed, 1_000, 'late-owned-process', {
    platform: 'darwin',
    ownershipToken: 'fixed-token',
    signal: 'SIGKILL',
    kill: (pid, signal) => signals.push([pid, signal]),
    readProcessTable: async () => {
      scans += 1
      return scans <= 2 ? [late] : []
    },
  })

  assert.deepEqual(
    [...observed.values()].map((record) => record.pid),
    [late.pid],
  )
  assert.deepEqual(signals, [
    [late.pid, 'SIGKILL'],
    [-late.processGroupId, 'SIGKILL'],
  ])
  assert.equal(scans, 4)
})

test('post-stop proof adopts a late markerless child and its separate group', async () => {
  const parent = {
    pid: 98,
    parentPid: 1,
    processGroupId: 98,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'late-parent',
    ownershipTokenMatched: true,
  }
  const child = {
    pid: 99,
    parentPid: parent.pid,
    processGroupId: 99,
    userId: parent.userId,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'markerless-child',
    ownershipTokenMatched: false,
  }
  const observed = new Map()
  const ownedGroups = new Map()
  const signals = []
  let scans = 0

  await waitForProcessesGone(observed, 1_000, 'late-owned-process', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownedGroups,
    ownershipToken: 'fixed-token',
    platform: 'darwin',
    readProcessTable: async () => {
      scans += 1
      return scans <= 3 ? [parent, child] : []
    },
    signal: 'SIGKILL',
  })

  assert.deepEqual(
    [...observed.values()].map((record) => [record.pid, record.ownershipBasis]),
    [
      [parent.pid, 'token'],
      [child.pid, 'ancestry'],
    ],
  )
  assert.deepEqual(
    [...ownedGroups.keys()],
    [parent.processGroupId, child.processGroupId],
  )
  assert.deepEqual(signals, [
    [parent.pid, 'SIGKILL'],
    [child.pid, 'SIGKILL'],
    [-parent.processGroupId, 'SIGKILL'],
    [-child.processGroupId, 'SIGKILL'],
  ])
  assert.equal(scans, 5)
})

test('late token leader retains its group after its child reparents', async () => {
  const parent = {
    pid: 98,
    parentPid: 1,
    processGroupId: 98,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'late-parent',
    ownershipTokenMatched: true,
  }
  const child = {
    pid: 99,
    parentPid: parent.pid,
    processGroupId: parent.processGroupId,
    userId: parent.userId,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'markerless-child',
    ownershipTokenMatched: false,
  }
  const reparentedChild = { ...child, parentPid: 1 }
  const startTicks = new Map([
    [parent.pid, 200],
    [child.pid, 300],
  ])
  const observed = new Map()
  const ownedGroups = new Map()
  const signals = []
  let scans = 0

  await waitForProcessesGone(observed, 1_000, 'late-owned-process', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownedGroups,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async (path) => {
      const pid = Number(path.split('/')[2])
      const entry =
        pid === parent.pid ? parent : scans >= 2 ? reparentedChild : child
      return linuxProcessStat(entry, startTicks.get(pid))
    },
    readProcessTable: async () => {
      scans += 1
      if (scans === 1) return [parent, child]
      if (scans <= 4) return [reparentedChild]
      return []
    },
    signal: 'SIGKILL',
  })

  assert.equal(ownedGroups.has(parent.processGroupId), true)
  assert.equal(
    signals.filter(
      ([pid, signal]) => pid === -parent.processGroupId && signal === 'SIGKILL',
    ).length,
    2,
  )
  assert.equal(
    signals.filter(([pid, signal]) => pid === child.pid && signal === 'SIGKILL')
      .length,
    2,
  )
  assert.equal(scans, 6)
})

test('vanished token parent cannot hide a markerless child after its snapshot', async () => {
  const parent = {
    pid: 98,
    parentPid: 1,
    processGroupId: 98,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'vanished-parent',
    ownershipTokenMatched: true,
  }
  const child = {
    pid: 99,
    parentPid: parent.pid,
    processGroupId: 99,
    userId: parent.userId,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'markerless-child',
    ownershipTokenMatched: false,
  }
  const missing = new Error('process disappeared')
  missing.code = 'ENOENT'
  const signals = []
  let scans = 0

  await assert.rejects(
    waitForProcessesGone(new Map(), 1_000, 'late-owned-process', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownedGroups: new Map(),
      ownershipToken: 'fixed-token',
      platform: 'linux',
      readFile: async () => {
        throw missing
      },
      readProcessTable: async () => {
        scans += 1
        return scans === 1 ? [parent, child] : [child]
      },
      signal: 'SIGKILL',
    }),
    /process-identity-unproved/,
  )

  assert.equal(scans, 1)
  assert.deepEqual(signals, [])
})

test('vanished ancestry child cannot hide its own markerless child', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'root',
    ownershipTokenMatched: true,
  }
  const vanished = {
    pid: 98,
    parentPid: root.pid,
    processGroupId: 98,
    userId: root.userId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'vanished-child',
    ownershipTokenMatched: false,
  }
  const escaped = {
    pid: 99,
    parentPid: vanished.pid,
    processGroupId: 99,
    userId: vanished.userId,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'markerless-grandchild',
    ownershipTokenMatched: false,
  }
  const rootRecord = await processRecord(root, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(root, 100),
  })
  const missing = new Error('process disappeared')
  missing.code = 'ENOENT'
  const signals = []

  await assert.rejects(
    waitForProcessesGone(
      new Map([[rootRecord.key, rootRecord]]),
      1_000,
      'late-owned-process',
      {
        kill: (pid, signal) => signals.push([pid, signal]),
        ownedGroups: new Map(),
        ownershipToken: 'fixed-token',
        platform: 'linux',
        readFile: async (path) => {
          if (path === `/proc/${root.pid}/stat`) {
            return linuxProcessStat(root, 100)
          }
          throw missing
        },
        readProcessTable: async () => [root, vanished, escaped],
        signal: 'SIGKILL',
      },
    ),
    /process-identity-unproved/,
  )

  assert.deepEqual(signals, [])
})

test('Linux tracker retains a TERM-discovered group across reparent and KILL', async () => {
  const root = {
    pid: 42,
    parentPid: 1,
    processGroupId: 42,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'root',
    ownershipTokenMatched: true,
  }
  const parent = {
    pid: 98,
    parentPid: root.pid,
    processGroupId: 98,
    userId: root.userId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    command: 'late-parent',
    ownershipTokenMatched: true,
  }
  const child = {
    pid: 99,
    parentPid: parent.pid,
    processGroupId: 99,
    userId: parent.userId,
    startedAt: 'Thu Jul 23 07:00:02 2026',
    command: 'markerless-child',
    ownershipTokenMatched: false,
  }
  const reparentedChild = { ...child, parentPid: 1 }
  let rows = [root]
  let concurrent = 0
  let maximumConcurrent = 0
  const signals = []
  const startTicks = new Map([
    [root.pid, 100],
    [parent.pid, 200],
    [child.pid, 300],
  ])
  const readLinuxStat = async (path) => {
    const pid = Number(path.split('/')[2])
    return linuxProcessStat(
      rows.find((entry) => entry.pid === pid),
      startTicks.get(pid),
    )
  }
  const tracker = startProcessTracker(root.pid, {
    ownershipToken: 'fixed-token',
    platform: 'linux',
    pollIntervalMs: 10_000,
    readFile: readLinuxStat,
    readProcessTable: async () => {
      concurrent += 1
      maximumConcurrent = Math.max(maximumConcurrent, concurrent)
      await Promise.resolve()
      concurrent -= 1
      return rows
    },
  })

  await tracker.ready
  rows = [root, parent, child]
  await tracker.adoptAndSignal('SIGTERM', {
    kill: (pid, signal) => signals.push([pid, signal]),
  })
  assert.deepEqual(
    [...tracker.snapshot().values()]
      .map((record) => record.pid)
      .sort((left, right) => left - right),
    [root.pid, parent.pid, child.pid],
  )
  assert.equal(tracker.groupSnapshot().has(child.processGroupId), true)

  rows = [root, reparentedChild]
  await tracker.stop()
  await assert.rejects(
    tracker.adoptAndSignal('SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
    }),
    /process-tracker-stopped/,
  )
  const postStopObserved = tracker.snapshot()
  const postStopGroups = tracker.groupSnapshot()
  await signalTrackedProcesses(postStopObserved, 'SIGKILL', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownedGroups: postStopGroups,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: readLinuxStat,
    readProcessTable: async () => rows,
  })

  assert.equal(
    signals.some(([pid, signal]) => pid === child.pid && signal === 'SIGKILL'),
    true,
  )
  assert.equal(
    signals.some(
      ([pid, signal]) => pid === -child.processGroupId && signal === 'SIGKILL',
    ),
    true,
  )
  rows = []
  await waitForProcessesGone(postStopObserved, 1_000, 'late-owned-process', {
    ownedGroups: postStopGroups,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: readLinuxStat,
    readProcessTable: async () => rows,
  })
  assert.equal(maximumConcurrent, 1)
})

test('cleanup revalidates a tracked identity immediately before signaling', async () => {
  const record = {
    key: '4242\\0linux:100\\01',
    pid: 4242,
    startIdentity: 'linux:100',
    generation: 1,
  }
  const observed = new Map([[record.key, record]])
  const signals = []
  let matches = []
  const dependencies = {
    matchingProcesses: async () => matches,
    kill: (pid, signal) => signals.push([pid, signal]),
  }

  await signalTrackedProcesses(observed, 'SIGTERM', dependencies)
  assert.deepEqual(signals, [])

  matches = [record]
  await signalTrackedProcesses(observed, 'SIGKILL', dependencies)
  assert.deepEqual(signals, [[4242, 'SIGKILL']])
})

test('cleanup revalidates group ownership after positive PID signals', async () => {
  const original = {
    pid: 4242,
    parentPid: 100,
    processGroupId: 4242,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const replacement = {
    ...original,
    parentPid: 1,
    ownershipTokenMatched: false,
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 100),
  })
  const observed = new Map([[record.key, record]])
  const ownedGroups = new Map([
    [
      original.processGroupId,
      {
        processGroupId: original.processGroupId,
        leaderRecord: record,
        memberKeys: [record.key],
      },
    ],
  ])
  const signals = []
  let replaced = false

  await signalTrackedProcesses(observed, 'SIGKILL', {
    kill: (pid, signal) => {
      signals.push([pid, signal])
      if (pid === original.pid) replaced = true
    },
    ownedGroups,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () =>
      linuxProcessStat(replaced ? replacement : original, replaced ? 200 : 100),
    readProcessTable: async () => [replaced ? replacement : original],
  })

  assert.deepEqual(signals, [[original.pid, 'SIGKILL']])
})

test('exit proof revalidates group ownership after positive PID signals', async () => {
  const original = {
    pid: 4242,
    parentPid: 100,
    processGroupId: 4242,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const replacement = {
    ...original,
    parentPid: 1,
    ownershipTokenMatched: false,
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 100),
  })
  const observed = new Map([[record.key, record]])
  const ownedGroups = new Map([
    [
      original.processGroupId,
      {
        processGroupId: original.processGroupId,
        leaderRecord: record,
        memberKeys: [record.key],
      },
    ],
  ])
  const signals = []
  let replaced = false

  await waitForProcessesGone(observed, 1_000, 'orphan-process', {
    kill: (pid, signal) => {
      signals.push([pid, signal])
      if (pid === original.pid) replaced = true
    },
    ownedGroups,
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () =>
      linuxProcessStat(replaced ? replacement : original, replaced ? 200 : 100),
    readProcessTable: async () => [replaced ? replacement : original],
    signal: 'SIGKILL',
  })

  assert.deepEqual(signals, [[original.pid, 'SIGKILL']])
})

test('Linux current stat coordinates reject stale process-table reuse', async () => {
  const staleRow = {
    pid: 4242,
    parentPid: 100,
    processGroupId: 200,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
  }
  const record = await processRecord(staleRow, 1, {
    platform: 'linux',
    ownershipBasis: 'ancestry',
    readFile: async () => linuxProcessStat(staleRow, 777),
  })
  const observed = new Map([[record.key, record]])
  const replacement = {
    ...staleRow,
    command: 'replacement',
    parentPid: 1,
    processGroupId: 999,
  }
  const signals = []

  await assert.rejects(
    signalTrackedProcesses(observed, 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      platform: 'linux',
      readFile: async () => linuxProcessStat(replacement, 888),
      readProcessTable: async () => [staleRow],
    }),
    /process-identity-unproved/,
  )

  assert.deepEqual(signals, [])
})

test('a retained PID cannot be readopted with a replacement start identity', async () => {
  const original = {
    pid: 4242,
    parentPid: 100,
    processGroupId: 4242,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'Supraspina',
    ownershipTokenMatched: true,
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 777),
  })
  const observed = new Map([[record.key, record]])
  const signals = []

  await assert.rejects(
    signalTrackedProcesses(observed, 'SIGKILL', {
      kill: (pid, signal) => signals.push([pid, signal]),
      ownershipToken: 'fixed-token',
      platform: 'linux',
      readFile: async () => linuxProcessStat(original, 888),
      readProcessTable: async () => [original],
    }),
    /process-identity-unproved/,
  )

  assert.deepEqual(signals, [])
  assert.equal(observed.size, 1)
})

test('Linux token ownership survives marker loss and exec by start identity', async () => {
  const original = {
    pid: 4242,
    parentPid: 100,
    processGroupId: 200,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'shell',
    ownershipTokenMatched: true,
  }
  const changed = {
    ...original,
    command: 'scientific-executable',
    parentPid: 1,
    processGroupId: 4242,
    ownershipTokenMatched: false,
  }
  const child = {
    command: 'scientific-child',
    parentPid: changed.pid,
    pid: 4243,
    processGroupId: changed.processGroupId,
    startedAt: 'Thu Jul 23 07:00:01 2026',
    userId: changed.userId,
    ownershipTokenMatched: false,
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 777),
  })
  const signals = []

  await signalTrackedProcesses(new Map([[record.key, record]]), 'SIGTERM', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async (path) =>
      path === `/proc/${changed.pid}/stat`
        ? linuxProcessStat(changed, 777)
        : linuxProcessStat(child, 900),
    readProcessTable: async () => [changed, child],
  })

  assert.equal(
    signals.some(
      ([pid, signal]) => pid === changed.pid && signal === 'SIGTERM',
    ),
    true,
  )
  assert.equal(
    signals.some(([pid, signal]) => pid === child.pid && signal === 'SIGTERM'),
    true,
  )
})

test('Linux markerless replacement cannot inherit durable token ownership', async () => {
  const original = {
    pid: 4242,
    parentPid: 100,
    processGroupId: 200,
    userId: 1000,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'shell',
    ownershipTokenMatched: true,
  }
  const replacement = {
    ...original,
    command: 'unrelated',
    parentPid: 1,
    processGroupId: 4242,
    ownershipTokenMatched: false,
  }
  const record = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(original, 777),
  })
  const signals = []

  await signalTrackedProcesses(new Map([[record.key, record]]), 'SIGKILL', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownershipToken: 'fixed-token',
    platform: 'linux',
    readFile: async () => linuxProcessStat(replacement, 888),
    readProcessTable: async () => [replacement],
  })

  assert.deepEqual(signals, [])
})

test('token ownership survives exec, reparenting, and process-group changes', async () => {
  const original = {
    pid: 4242,
    parentPid: 100,
    processGroupId: 200,
    userId: 501,
    startedAt: 'Thu Jul 23 07:00:00 2026',
    command: 'shell',
    ownershipTokenMatched: true,
  }
  const changed = {
    ...original,
    parentPid: 1,
    processGroupId: 4242,
    command: 'scientific-executable',
  }
  const reused = {
    ...changed,
    startedAt: 'Thu Jul 23 07:00:01 2026',
  }

  const originalRecord = await processRecord(original, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const reusedRecord = await processRecord(reused, 1, {
    ownershipBasis: 'token',
    ownershipToken: 'fixed-token',
    platform: 'darwin',
  })
  const observed = new Map([[originalRecord.key, originalRecord]])
  const signals = []

  assert.notEqual(originalRecord.startIdentity, reusedRecord.startIdentity)
  await signalTrackedProcesses(observed, 'SIGTERM', {
    kill: (pid, signal) => signals.push([pid, signal]),
    ownershipToken: 'fixed-token',
    platform: 'darwin',
    readProcessTable: async () => [changed],
  })
  assert.deepEqual(signals, [
    [original.pid, 'SIGTERM'],
    [-changed.processGroupId, 'SIGTERM'],
  ])
})
