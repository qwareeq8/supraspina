import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { version as APP_VERSION } from '../../package.json'
import {
  REQUIRED_SIDECAR_CAPABILITIES,
  type SidecarHostState,
} from '../shared/contract'
import {
  PACKAGE_SMOKE_FLAG,
  PACKAGE_SMOKE_RENDERER_POISON,
  PACKAGE_SMOKE_SENTINEL,
  PackageSmokeCoordinator,
  containsSensitiveSmokeDiagnostic,
  emitPackageSmokeReport,
  inspectPackageSmokePaths,
  isPackageSmokeLaunchPolicySatisfied,
  isPackageSmokeMode,
  packageSmokeReportIsSafe,
  packageSmokeChecksPass,
  packageSmokePathsAreValid,
  publishPackageSmokeReport,
  type PackageSmokePathAccess,
  type PackageSmokeReport,
} from './package-smoke'

const temporaryRoots: string[] = []
const smokeCoordinators: PackageSmokeCoordinator[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const path of temporaryRoots.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
  for (const coordinator of smokeCoordinators.splice(0)) {
    coordinator.dispose()
  }
})

function trackedCoordinator(
  invocation: ConstructorParameters<typeof PackageSmokeCoordinator>[0],
): PackageSmokeCoordinator {
  const coordinator = new PackageSmokeCoordinator(invocation)
  smokeCoordinators.push(coordinator)
  return coordinator
}

function fakeAccess(entries: Record<string, 'file' | 'directory'>) {
  const access: PackageSmokePathAccess = {
    kind: (path) => entries[path] ?? 'missing',
    isExecutable: (path) => entries[path] === 'file',
  }
  return access
}

function canonicalPaths(resourcesPath = '/opt/Supraspina/resources') {
  const appPath = join(resourcesPath, 'app.asar')
  return {
    appPath,
    resourcesPath,
    rendererPath: join(appPath, 'out', 'renderer', 'index.html'),
    preloadPath: join(appPath, 'out', 'preload', 'index.cjs'),
    platform: 'linux' as const,
    env: { ELECTRON_RENDERER_URL: PACKAGE_SMOKE_RENDERER_POISON },
  }
}

function canonicalEntries(resourcesPath = '/opt/Supraspina/resources') {
  return {
    [join(resourcesPath, 'app.asar', 'out', 'renderer', 'index.html')]:
      'file' as const,
    [join(resourcesPath, 'app.asar', 'out', 'preload', 'index.cjs')]:
      'file' as const,
    [join(resourcesPath, 'icon.png')]: 'file' as const,
    [join(resourcesPath, 'sidecar', 'supraspina-sidecar')]: 'file' as const,
    [join(resourcesPath, 'sidecar', 'supraspina-runtime')]:
      'directory' as const,
    [join(resourcesPath, 'micromamba', 'micromamba')]: 'file' as const,
    [join(resourcesPath, 'LICENSE')]: 'file' as const,
    [join(resourcesPath, 'THIRD_PARTY_NOTICES')]: 'file' as const,
    [join(resourcesPath, 'THIRD_PARTY_PROVENANCE.json')]: 'file' as const,
    [join(resourcesPath, 'dependency-manifests', 'node-distributable.json')]:
      'file' as const,
    [join(
      resourcesPath,
      'dependency-manifests',
      'node-third-party-notices.txt',
    )]: 'file' as const,
    [join(
      resourcesPath,
      'dependency-manifests',
      'python-release-linux-x86_64.cyclonedx.json',
    )]: 'file' as const,
    [join(
      resourcesPath,
      'dependency-manifests',
      'python-release-linux-x86_64-notices.txt',
    )]: 'file' as const,
    [join(resourcesPath, 'dependency-manifests', 'package-lock.json')]:
      'file' as const,
    [join(
      resourcesPath,
      'dependency-manifests',
      'python-locks',
      'release-linux-x86_64.txt',
    )]: 'file' as const,
    [join(
      resourcesPath,
      'dependency-manifests',
      'python-locks',
      'release-toolchain.json',
    )]: 'file' as const,
    [join(
      resourcesPath,
      'sidecar',
      'supraspina-runtime',
      'metadata',
      'THIRD_PARTY_PROVENANCE.json',
    )]: 'file' as const,
    [join(
      resourcesPath,
      'sidecar',
      'supraspina-runtime',
      'metadata',
      'SCIENTIFIC_RESOURCE_PINS.json',
    )]: 'file' as const,
    [join(
      resourcesPath,
      'sidecar',
      'supraspina-runtime',
      'resources',
      'step7',
      'brainpadstats.py',
    )]: 'file' as const,
    [join(
      resourcesPath,
      'sidecar',
      'supraspina-runtime',
      'resources',
      'brainfov',
      'brainfov_helper.py',
    )]: 'file' as const,
  }
}

async function realCanonicalPaths() {
  const root = await mkdtemp(join(tmpdir(), 'supraspina-package-smoke-'))
  temporaryRoots.push(root)
  const resourcesPath = join(root, 'resources')
  const appPath = join(resourcesPath, 'app.asar')
  const rendererPath = join(appPath, 'out', 'renderer', 'index.html')
  const preloadPath = join(appPath, 'out', 'preload', 'index.cjs')
  const launcher = join(resourcesPath, 'sidecar', 'supraspina-sidecar')
  const micromamba = join(resourcesPath, 'micromamba', 'micromamba')
  const dependencyDirectory = join(resourcesPath, 'dependency-manifests')
  const runtime = join(resourcesPath, 'sidecar', 'supraspina-runtime')
  await Promise.all([
    mkdir(join(appPath, 'out', 'renderer'), { recursive: true }),
    mkdir(join(appPath, 'out', 'preload'), { recursive: true }),
    mkdir(join(resourcesPath, 'sidecar', 'supraspina-runtime'), {
      recursive: true,
    }),
    mkdir(join(resourcesPath, 'micromamba'), { recursive: true }),
    mkdir(join(dependencyDirectory, 'python-locks'), { recursive: true }),
    mkdir(join(runtime, 'metadata'), { recursive: true }),
    mkdir(join(runtime, 'resources', 'step7'), { recursive: true }),
    mkdir(join(runtime, 'resources', 'brainfov'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(rendererPath, '<div id="root"></div>'),
    writeFile(preloadPath, 'module.exports = {}'),
    writeFile(join(resourcesPath, 'icon.png'), 'icon'),
    writeFile(launcher, '#!/bin/sh\nexit 0\n'),
    writeFile(micromamba, '#!/bin/sh\nexit 0\n'),
    writeFile(join(resourcesPath, 'LICENSE'), 'MIT'),
    writeFile(join(resourcesPath, 'THIRD_PARTY_NOTICES'), 'notices'),
    writeFile(
      join(resourcesPath, 'THIRD_PARTY_PROVENANCE.json'),
      '{"schemaVersion":1}',
    ),
    ...[
      'node-distributable.json',
      'node-third-party-notices.txt',
      'python-release-linux-x86_64.cyclonedx.json',
      'python-release-linux-x86_64-notices.txt',
      'package-lock.json',
    ].map((name) => writeFile(join(dependencyDirectory, name), 'metadata')),
    writeFile(
      join(dependencyDirectory, 'python-locks', 'release-linux-x86_64.txt'),
      'lock',
    ),
    writeFile(
      join(dependencyDirectory, 'python-locks', 'release-toolchain.json'),
      '{}',
    ),
    writeFile(
      join(runtime, 'metadata', 'THIRD_PARTY_PROVENANCE.json'),
      '{"schemaVersion":1}',
    ),
    writeFile(
      join(runtime, 'metadata', 'SCIENTIFIC_RESOURCE_PINS.json'),
      '{"schemaVersion":1}',
    ),
    writeFile(
      join(runtime, 'resources', 'step7', 'brainpadstats.py'),
      'print("fixture")',
    ),
    writeFile(
      join(runtime, 'resources', 'brainfov', 'brainfov_helper.py'),
      'print("fixture")',
    ),
  ])
  await Promise.all([chmod(launcher, 0o755), chmod(micromamba, 0o755)])
  return {
    appPath,
    resourcesPath,
    rendererPath,
    preloadPath,
    platform: 'linux' as const,
    env: { ELECTRON_RENDERER_URL: PACKAGE_SMOKE_RENDERER_POISON },
  }
}

function readySidecarState(): SidecarHostState {
  return {
    state: 'ready' as const,
    generation: 1,
    productVersion: APP_VERSION,
    protocolVersion: '1',
    persistenceVersions: { project: 1, runState: 1, manifest: 1, receipt: 1 },
    capabilities: [...REQUIRED_SIDECAR_CAPABILITIES],
    runtimeId: 'packaged-runtime',
    projectAttached: false,
    retryable: false,
    detail: null,
  }
}

function stoppedSidecarState(): SidecarHostState {
  return {
    ...readySidecarState(),
    state: 'unavailable' as const,
    runtimeId: null,
  }
}

function successfulProbe(overrides: Record<string, unknown> = {}) {
  const state = readySidecarState()
  return {
    rendererStarted: true,
    preloadBridge: true,
    rendererSandboxed: true,
    rendererInAsar: true,
    hostMode: 'electron',
    sidecarState: 'ready',
    sidecarGeneration: state.generation,
    sidecarProductVersion: state.productVersion,
    sidecarProtocolVersion: state.protocolVersion,
    sidecarCapabilities: state.capabilities,
    sidecarPersistenceCompatible: true,
    sidecarRuntimeIdentityPresent: true,
    sidecarProjectAttached: false,
    safeNoProject: true,
    updateCapability: 'full',
    updatePhase: 'idle',
    remoteResourceCount: 0,
    resourcesAreLocal: true,
    requestedFaceCount: 18,
    loadedFaceCount: 18,
    fontResourcesComplete: true,
    fontResourcesLocal: true,
    fontSynthesisNone: true,
    ...overrides,
  }
}

function fakeSession() {
  const requestHandlers: Array<
    (
      details: unknown,
      callback: (response: { cancel: boolean }) => void,
    ) => void
  > = []
  return {
    requestHandlers,
    session: {
      webRequest: {
        onBeforeRequest: vi.fn(
          (
            _filter: unknown,
            handler: (
              details: unknown,
              callback: (response: { cancel: boolean }) => void,
            ) => void,
          ) => requestHandlers.push(handler),
        ),
      },
    },
  }
}

function fakeWindow(probe: unknown = successfulProbe()) {
  const rendererSession = fakeSession()
  const webContents = new EventEmitter() as EventEmitter & {
    session: ReturnType<typeof fakeSession>['session']
    executeJavaScript: ReturnType<typeof vi.fn>
  }
  webContents.session = rendererSession.session
  webContents.executeJavaScript = vi.fn(async () => probe)
  const window = new EventEmitter() as EventEmitter & {
    webContents: typeof webContents
  }
  window.webContents = webContents
  return { window, webContents, rendererSession }
}

function fakeSidecar(
  options: {
    initial?: SidecarHostState
    startError?: Error
    stopError?: Error
    callResults?: Record<string, unknown>
  } = {},
) {
  let state = options.initial ?? readySidecarState()
  let clinicalCase = 'valid'
  const clinicalSubject = {
    id: 'smoke-001',
    stepStates: { clinical: 'done' },
  }
  return {
    start: vi.fn(async () => {
      if (options.startError) throw options.startError
    }),
    stop: vi.fn(async () => {
      if (options.stopError) throw options.stopError
      state = stoppedSidecarState()
    }),
    getState: vi.fn(() => state),
    call: vi.fn(async (method: string, params: unknown) => {
      if (Object.hasOwn(options.callResults ?? {}, method)) {
        return options.callResults![method]
      }
      if (method === 'system.packageSmokeClinicalSetup') {
        return {
          token: 'clinical-smoke-token',
          project: {
            projectId: 'clinical-smoke',
            root: '/temporary/clinical-smoke',
            configPath: '/temporary/clinical-smoke/supraspina.project.json',
            epoch: 1,
          },
          cfg: { paths: { projectRoot: '/temporary/clinical-smoke' } },
          subjectId: clinicalSubject.id,
          openpyxlRuntime: true,
        }
      }
      if (method === 'subjects.discover') {
        return [
          {
            ...clinicalSubject,
            stepStates: {
              clinical: clinicalCase === 'valid' ? 'done' : 'pending',
            },
          },
        ]
      }
      if (method === 'subjects.refreshOne') {
        return {
          ...clinicalSubject,
          stepStates: {
            clinical: clinicalCase === 'valid' ? 'done' : 'pending',
          },
        }
      }
      if (method === 'system.packageSmokeClinicalCase') {
        const request = Array.isArray(params) ? params[0] : null
        clinicalCase =
          request &&
          typeof request === 'object' &&
          'case' in request &&
          typeof request.case === 'string'
            ? request.case
            : ''
        return {
          caseApplied: true,
          dependencyRejected: clinicalCase === 'missing-dependency',
        }
      }
      if (method === 'system.packageSmokeClinicalExecute') {
        return { started: true }
      }
      if (method === 'system.packageSmokeClinicalExecutionStatus') {
        return {
          complete: true,
          liveZeroExit: true,
          durableReceipt: true,
          dependentEligible: true,
          outputReopened: true,
        }
      }
      if (method === 'provision.pybrainage') {
        return { operationId: 'provision-012345abcdef' }
      }
      if (method === 'provision.status') {
        return {
          phase: 'done',
          envReady: true,
          modelReady: true,
        }
      }
      if (method === 'system.packageSmokePybrainageExecute') {
        return { zeroExit: true, outputReopened: true }
      }
      if (method === 'system.packageSmokeClinicalCleanup') {
        return { projectDetached: true, temporaryDataRemoved: true }
      }
      throw new Error(
        `Handle only expected sidecar methods; received ${method}.`,
      )
    }),
  }
}

async function runObservedSmoke(
  options: {
    paths?: Awaited<ReturnType<typeof realCanonicalPaths>>
    probe?: unknown
    sidecar?: ReturnType<typeof fakeSidecar>
    invocation?: {
      enabled: boolean
      argv: readonly string[]
      platform: NodeJS.Platform
      env: NodeJS.ProcessEnv
    }
    beforeRun?: (
      target: ReturnType<typeof fakeWindow>,
      coordinator: PackageSmokeCoordinator,
    ) => void
  } = {},
) {
  const paths = options.paths ?? (await realCanonicalPaths())
  const target = fakeWindow(
    Object.hasOwn(options, 'probe') ? options.probe : successfulProbe(),
  )
  const updaterSession = fakeSession()
  const sidecar = options.sidecar ?? fakeSidecar()
  const coordinator = trackedCoordinator(
    options.invocation ?? {
      enabled: true,
      argv: [PACKAGE_SMOKE_FLAG],
      platform: 'linux',
      env: {},
    },
  )
  coordinator.observeWindow(
    target.window as never,
    updaterSession.session as never,
  )
  options.beforeRun?.(target, coordinator)
  target.webContents.emit('did-finish-load')
  const report = await coordinator.run({ paths, sidecar: sidecar as never })
  return { report, sidecar, target, updaterSession, coordinator }
}

describe('packaged smoke mode', () => {
  it('releases process observers after a completed smoke', async () => {
    const uncaughtBefore = process.listenerCount('uncaughtException')
    const rejectionBefore = process.listenerCount('unhandledRejection')
    const { coordinator } = await runObservedSmoke()

    expect(process.listenerCount('uncaughtException')).toBe(uncaughtBefore)
    expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore)

    coordinator.dispose()
    expect(process.listenerCount('uncaughtException')).toBe(uncaughtBefore)
    expect(process.listenerCount('unhandledRejection')).toBe(rejectionBefore)
  })

  it('remains inert without both the exact flag and packaged runtime', () => {
    expect(isPackageSmokeMode(false, [PACKAGE_SMOKE_FLAG])).toBe(false)
    expect(isPackageSmokeMode(true, [])).toBe(false)
    expect(isPackageSmokeMode(true, [`${PACKAGE_SMOKE_FLAG}=1`])).toBe(false)
  })

  it('enables only for an explicit packaged smoke launch', () => {
    expect(isPackageSmokeMode(true, ['supraspina', PACKAGE_SMOKE_FLAG])).toBe(
      true,
    )
  })

  it('never requires no-sandbox in the normal smoke arguments', () => {
    expect(
      isPackageSmokeLaunchPolicySatisfied({
        enabled: true,
        argv: [PACKAGE_SMOKE_FLAG],
        platform: 'linux',
        env: {},
      }),
    ).toBe(true)
  })

  it('accepts no-sandbox only with the explicit Linux CI marker', () => {
    const base = {
      enabled: true,
      argv: [PACKAGE_SMOKE_FLAG, '--no-sandbox'],
      platform: 'linux' as const,
    }

    expect(
      isPackageSmokeLaunchPolicySatisfied({ ...base, env: { CI: 'true' } }),
    ).toBe(false)
    expect(
      isPackageSmokeLaunchPolicySatisfied({
        ...base,
        env: { CI: 'true', SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX: '1' },
      }),
    ).toBe(true)
    expect(
      isPackageSmokeLaunchPolicySatisfied({
        ...base,
        env: { CI: '1', SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX: '1' },
      }),
    ).toBe(true)
    expect(
      isPackageSmokeLaunchPolicySatisfied({
        ...base,
        platform: 'darwin',
        env: { CI: 'true', SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX: '1' },
      }),
    ).toBe(false)
  })
})

describe('packaged smoke diagnostic safety', () => {
  it('accepts the fixed report vocabulary without free-form diagnostics', () => {
    expect(
      packageSmokeReportIsSafe({
        schemaVersion: 1,
        ok: false,
        platform: 'linux',
        failureCode: 'sidecar-handshake',
        checks: { noSensitiveDiagnostics: true },
      }),
    ).toBe(true)
  })

  it.each([
    'file:///home/operator/study/sub-001/report.json',
    '/data/derivatives/study/sub-001',
    '/workspace/custom/study.json',
    String.raw`C:\Users\operator\study`,
    String.raw`\\server\subjects\patient.json`,
    'participant_id=sub-001',
    'patient_name: Example Person',
    'operator@example.org',
    'Authorization: Bearer private-token',
  ])('rejects path, study identity, or credential material: %s', (value) => {
    expect(containsSensitiveSmokeDiagnostic(value)).toBe(true)
  })
})

describe('packaged smoke paths', () => {
  it('accepts only the canonical ASAR and frozen sidecar topology', () => {
    const paths = canonicalPaths()
    const checks = inspectPackageSmokePaths(
      paths,
      fakeAccess(canonicalEntries()),
    )

    expect(checks).toEqual({
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
    })
    expect(packageSmokePathsAreValid(checks)).toBe(true)
  })

  it('rejects a checkout renderer and missing frozen runtime', () => {
    const paths = {
      ...canonicalPaths(),
      rendererPath: '/srv/example-checkout/out/renderer/index.html',
    }
    const entries = canonicalEntries()
    delete entries[join(paths.resourcesPath, 'sidecar', 'supraspina-runtime')]
    const checks = inspectPackageSmokePaths(paths, fakeAccess(entries))

    expect(checks.rendererEntryInAsar).toBe(false)
    expect(checks.frozenSidecarRuntime).toBe(false)
    expect(packageSmokePathsAreValid(checks)).toBe(false)
  })

  it('rejects a missing or non-executable bundled micromamba runtime', () => {
    const paths = canonicalPaths()
    const entries = canonicalEntries()
    const micromamba = join(paths.resourcesPath, 'micromamba', 'micromamba')
    delete entries[micromamba]

    const missing = inspectPackageSmokePaths(paths, fakeAccess(entries))
    expect(missing.bundledMicromamba).toBe(false)
    expect(missing.bundledMicromambaExecutable).toBe(false)
    expect(packageSmokePathsAreValid(missing)).toBe(false)

    entries[micromamba] = 'file'
    const access = fakeAccess(entries)
    access.isExecutable = (path) => path !== micromamba
    const nonExecutable = inspectPackageSmokePaths(paths, access)
    expect(nonExecutable.bundledMicromamba).toBe(true)
    expect(nonExecutable.bundledMicromambaExecutable).toBe(false)
    expect(packageSmokePathsAreValid(nonExecutable)).toBe(false)
  })

  it('rejects every developer runtime override before sidecar start', () => {
    const paths = {
      ...canonicalPaths(),
      env: {
        SUPRASPINA_SIDECAR: '/tmp/developer-python',
        ELECTRON_RENDERER_URL: 'http://localhost:5173',
      },
    }
    const checks = inspectPackageSmokePaths(
      paths,
      fakeAccess(canonicalEntries()),
    )

    expect(checks.noDeveloperOverrides).toBe(false)
    expect(checks.rendererPoisonIgnored).toBe(false)
    expect(packageSmokePathsAreValid(checks)).toBe(false)
  })

  it('selects the fixed Linux frozen-runtime paths on every host', () => {
    const resourcesPath = '/opt/Supraspina/resources'
    const entries = canonicalEntries(resourcesPath)
    const linux = inspectPackageSmokePaths(
      canonicalPaths(resourcesPath),
      fakeAccess(entries),
    )

    expect(linux.dependencyManifests).toBe(true)
    expect(linux.frozenSidecarLauncher).toBe(true)
    expect(linux.frozenSidecarExecutable).toBe(true)

    // Resolve the same Linux target and launcher name from any reported
    // platform, so no non-Linux dependency manifest can satisfy the contract.
    for (const platform of ['darwin', 'win32'] as const) {
      expect(
        inspectPackageSmokePaths(
          { ...canonicalPaths(resourcesPath), platform },
          fakeAccess(entries),
        ),
      ).toEqual(linux)
    }
  })

  it('exercises the real default path inspector without checkout fallbacks', async () => {
    const paths = await realCanonicalPaths()
    const checks = inspectPackageSmokePaths(paths)

    expect(checks).toMatchObject({
      resourcesPathAbsolute: true,
      appAsar: true,
      rendererEntryInAsar: true,
      preloadEntryInAsar: true,
      frozenSidecarLauncher: true,
      frozenSidecarRuntime: true,
      frozenSidecarExecutable: true,
      bundledMicromamba: true,
      bundledMicromambaExecutable: true,
    })
    expect(packageSmokePathsAreValid(checks)).toBe(true)
  })
})

describe('packaged smoke runtime coordinator', () => {
  it('proves the packaged main, renderer, preload, frozen sidecar, fonts, and shutdown', async () => {
    const { report, sidecar, target, updaterSession } = await runObservedSmoke()

    expect(report.ok).toBe(true)
    expect(report.failureCode).toBeNull()
    expect(packageSmokeChecksPass(report.checks)).toBe(true)
    expect(report.checks.nativeScienceRequested).toBe(false)
    expect(report.checks.pybrainageProvisioned).toBe(false)
    expect(sidecar.start).toHaveBeenCalledOnce()
    expect(sidecar.stop).toHaveBeenCalledOnce()
    expect(target.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('globalThis.supraspina'),
      true,
    )
    expect(target.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('style.fontFamily'),
      true,
    )
    expect(target.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('.split(",")[0]'),
      true,
    )
    expect(target.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('button[aria-label="Open a saved project"]'),
      true,
    )
    expect(target.rendererSession.requestHandlers).toHaveLength(1)
    expect(updaterSession.requestHandlers).toHaveLength(1)
  })

  it('blocks observed remote requests and fails the no-network contract', async () => {
    const { report, target, updaterSession } = await runObservedSmoke({
      beforeRun: (observed) => {
        for (const handler of observed.rendererSession.requestHandlers) {
          const callback = vi.fn()
          handler({}, callback)
          expect(callback).toHaveBeenCalledWith({ cancel: true })
        }
      },
    })
    const updaterCallback = vi.fn()
    updaterSession.requestHandlers[0]!({}, updaterCallback)
    expect(updaterCallback).toHaveBeenCalledWith({ cancel: true })

    expect(target.rendererSession.requestHandlers).toHaveLength(1)
    expect(report.ok).toBe(false)
    expect(report.failureCode).toBe('runtime-contract')
    expect(report.checks.noUpdateNetwork).toBe(false)
  })

  it('runs pinned PyBrainAge provisioning only for native science acceptance', async () => {
    const sidecar = fakeSidecar()
    const { report } = await runObservedSmoke({
      sidecar,
      invocation: {
        enabled: true,
        argv: [PACKAGE_SMOKE_FLAG],
        platform: 'linux',
        env: { SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE: '1' },
      },
    })

    expect(report.ok).toBe(true)
    expect(report.checks).toMatchObject({
      nativeScienceRequested: true,
      pybrainageProvisioned: true,
      pybrainageReady: true,
      pybrainagePredictionReopened: true,
    })
    expect(sidecar.call).toHaveBeenCalledWith(
      'system.packageSmokePybrainageExecute',
      [{ token: 'clinical-smoke-token' }],
    )
  })

  it.each([
    {
      name: 'malformed provisioning operation',
      callResults: { 'provision.pybrainage': { operationId: '' } },
      expected: {
        pybrainageProvisioned: false,
        pybrainageReady: false,
        pybrainagePredictionReopened: false,
      },
    },
    {
      name: 'incomplete provisioned runtime',
      callResults: {
        'provision.status': {
          phase: 'done',
          envReady: true,
          modelReady: false,
        },
      },
      expected: {
        pybrainageProvisioned: true,
        pybrainageReady: false,
        pybrainagePredictionReopened: false,
      },
    },
    {
      name: 'prediction output that cannot be reopened',
      callResults: {
        'system.packageSmokePybrainageExecute': {
          zeroExit: true,
          outputReopened: false,
        },
      },
      expected: {
        pybrainageProvisioned: true,
        pybrainageReady: true,
        pybrainagePredictionReopened: false,
      },
    },
  ])('fails closed for $name', async ({ callResults, expected }) => {
    const sidecar = fakeSidecar({ callResults })
    const { report } = await runObservedSmoke({
      sidecar,
      invocation: {
        enabled: true,
        argv: [PACKAGE_SMOKE_FLAG],
        platform: 'linux',
        env: { SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE: '1' },
      },
    })

    expect(report.ok).toBe(false)
    expect(report.failureCode).toBe('runtime-contract')
    expect(report.checks).toMatchObject({
      nativeScienceRequested: true,
      ...expected,
      clinicalProjectDetached: true,
      clinicalTemporaryDataRemoved: true,
    })
  })

  it('classifies console, preload, renderer, and process diagnostics', async () => {
    const { report } = await runObservedSmoke({
      beforeRun: ({ window, webContents }, coordinator) => {
        webContents.emit('console-message', {
          level: 'info',
          message: 'Mark the packaged renderer as ready.',
        })
        webContents.emit('console-message', {
          level: 'error',
          message: 'file:///private/study/sub-001',
        })
        webContents.emit('preload-error')
        webContents.emit('render-process-gone')
        window.emit('unresponsive')
        const processHandlers = coordinator as unknown as {
          uncaughtExceptionHandler(error: Error): void
          unhandledRejectionHandler(reason: unknown): void
        }
        processHandlers.unhandledRejectionHandler(
          'file:///private/rejection/path',
        )
        processHandlers.uncaughtExceptionHandler(
          new Error('file:///private/exception/path'),
        )
      },
    })

    expect(report.ok).toBe(false)
    expect(report.failureCode).toBe('diagnostics')
    expect(report.checks.noProcessErrors).toBe(false)
    expect(report.checks.noRendererErrors).toBe(false)
    expect(report.checks.noSensitiveDiagnostics).toBe(false)
  })

  it('maps launch, path, handshake, renderer, probe, contract, and shutdown failures', async () => {
    const validPaths = await realCanonicalPaths()

    const launch = await runObservedSmoke({
      paths: validPaths,
      invocation: {
        enabled: true,
        argv: [PACKAGE_SMOKE_FLAG, '--no-sandbox'],
        platform: 'linux',
        env: { CI: 'true' },
      },
    })
    expect(launch.report.failureCode).toBe('launch-policy')

    const invalidPaths = {
      ...validPaths,
      rendererPath: join(validPaths.resourcesPath, 'checkout', 'index.html'),
    }
    const paths = await runObservedSmoke({ paths: invalidPaths })
    expect(paths.report.failureCode).toBe('packaged-paths')

    const start = await runObservedSmoke({
      paths: validPaths,
      sidecar: fakeSidecar({ startError: new Error('/private/start/path') }),
    })
    expect(start.report.failureCode).toBe('sidecar-handshake')

    const incompatible = fakeSidecar({
      initial: { ...readySidecarState(), protocolVersion: '2' },
    })
    const handshake = await runObservedSmoke({
      paths: validPaths,
      sidecar: incompatible,
    })
    expect(handshake.report.failureCode).toBe('sidecar-handshake')

    const productMismatch = await runObservedSmoke({
      paths: validPaths,
      sidecar: fakeSidecar({
        initial: { ...readySidecarState(), productVersion: '999.0.0' },
      }),
    })
    expect(productMismatch.report.failureCode).toBe('sidecar-handshake')

    const missingRenderer = trackedCoordinator({
      enabled: true,
      argv: [PACKAGE_SMOKE_FLAG],
      platform: 'linux',
      env: {},
    })
    const rendererSidecar = fakeSidecar()
    const renderer = await missingRenderer.run({
      paths: validPaths,
      sidecar: rendererSidecar as never,
    })
    expect(renderer.failureCode).toBe('renderer-start')

    const probeTarget = fakeWindow()
    probeTarget.webContents.executeJavaScript.mockRejectedValueOnce(
      new Error('/private/renderer/path'),
    )
    const probeCoordinator = trackedCoordinator({
      enabled: true,
      argv: [PACKAGE_SMOKE_FLAG],
      platform: 'linux',
      env: {},
    })
    probeCoordinator.observeWindow(
      probeTarget.window as never,
      fakeSession().session as never,
    )
    probeTarget.webContents.emit('did-finish-load')
    const probe = await probeCoordinator.run({
      paths: validPaths,
      sidecar: fakeSidecar() as never,
    })
    expect(probe.failureCode).toBe('renderer-probe')

    const invalidProbe = await runObservedSmoke({
      paths: validPaths,
      probe: null,
    })
    expect(invalidProbe.report.failureCode).toBe('renderer-probe')

    const contract = await runObservedSmoke({
      paths: validPaths,
      probe: successfulProbe({ loadedFaceCount: 17 }),
    })
    expect(contract.report.failureCode).toBe('runtime-contract')
    expect(contract.report.checks.computerModernFaces).toBe(false)

    const shutdown = await runObservedSmoke({
      paths: validPaths,
      sidecar: fakeSidecar({ stopError: new Error('/private/stop/path') }),
    })
    expect(shutdown.report.failureCode).toBe('shutdown')
    expect(shutdown.report.checks.sidecarStopped).toBe(false)
  })

  it('fails closed for malformed Clinical sidecar projections', async () => {
    const malformedSession = await runObservedSmoke({
      sidecar: fakeSidecar({
        callResults: { 'system.packageSmokeClinicalSetup': null },
      }),
    })
    expect(malformedSession.report.failureCode).toBe('runtime-contract')

    const malformedRows = await runObservedSmoke({
      sidecar: fakeSidecar({
        callResults: {
          'subjects.discover': 'not-an-array',
          'subjects.refreshOne': {},
        },
      }),
    })
    expect(malformedRows.report.checks.clinicalDiscoveryDone).toBe(false)
    expect(malformedRows.report.checks.clinicalRefreshDone).toBe(false)

    const wrongStateTypes = await runObservedSmoke({
      sidecar: fakeSidecar({
        callResults: {
          'subjects.discover': [
            { id: 'smoke-001', stepStates: { clinical: 7 } },
          ],
          'subjects.refreshOne': {
            id: 'smoke-001',
            stepStates: { clinical: 7 },
          },
        },
      }),
    })
    expect(wrongStateTypes.report.checks.clinicalDiscoveryDone).toBe(false)
    expect(wrongStateTypes.report.checks.clinicalRefreshDone).toBe(false)
  })

  it('rejects a renderer probe with an untyped capability set', async () => {
    const { report } = await runObservedSmoke({
      probe: successfulProbe({ sidecarCapabilities: 'not-an-array' }),
    })
    expect(report.failureCode).toBe('runtime-contract')
    expect(report.checks.sidecarHandshake).toBe(false)
  })

  it('fails closed if even the fixed report envelope becomes sensitive', async () => {
    const { report } = await runObservedSmoke({
      invocation: {
        enabled: true,
        argv: [PACKAGE_SMOKE_FLAG],
        platform: 'file:///private/platform' as NodeJS.Platform,
        env: {},
      },
    })

    expect(report.ok).toBe(false)
    expect(report.failureCode).toBe('diagnostics')
    expect(report.checks.noSensitiveDiagnostics).toBe(false)
  })

  it('classifies a main-frame load failure but ignores a subframe failure', async () => {
    const paths = await realCanonicalPaths()
    const target = fakeWindow()
    const coordinator = trackedCoordinator({
      enabled: true,
      argv: [PACKAGE_SMOKE_FLAG],
      platform: 'linux',
      env: {},
    })
    coordinator.observeWindow(
      target.window as never,
      fakeSession().session as never,
    )
    target.webContents.emit('did-fail-load', {}, -1, 'subframe', 'file:', false)
    target.webContents.emit('did-fail-load', {}, -1, 'main', 'file:', true)

    const report = await coordinator.run({
      paths,
      sidecar: fakeSidecar() as never,
    })
    expect(report.failureCode).toBe('renderer-start')
    expect(report.checks.noRendererErrors).toBe(false)
  })
})

describe('packaged smoke report publication', () => {
  const report: PackageSmokeReport = {
    schemaVersion: 1,
    productVersion: APP_VERSION,
    sidecarProductVersion: APP_VERSION,
    ok: false,
    platform: 'linux',
    failureCode: 'runtime-contract',
    checks: Object.fromEntries(
      [
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
      ].map((key) => [key, false]),
    ) as unknown as PackageSmokeReport['checks'],
  }

  it('emits exactly one path-free sentinel line', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk,
      callback?: () => void,
    ) => {
      callback?.()
      return true
    }) as typeof process.stdout.write)

    await emitPackageSmokeReport(report)

    expect(write).toHaveBeenCalledOnce()
    expect(String(write.mock.calls[0]![0])).toBe(
      `${PACKAGE_SMOKE_SENTINEL}${JSON.stringify(report)}\n`,
    )
  })

  it('publishes once and completes after the direct stdout flush', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk,
      callback?: () => void,
    ) => {
      callback?.()
      return true
    }) as typeof process.stdout.write)

    await expect(publishPackageSmokeReport(report)).resolves.toBeUndefined()
    expect(write).toHaveBeenCalledOnce()
  })

  it('bounds a stalled direct stdout flush', async () => {
    vi.useFakeTimers()
    vi.spyOn(process.stdout, 'write').mockImplementation(
      (() => true) as typeof process.stdout.write,
    )

    const publishing = publishPackageSmokeReport(report)

    let settled = false
    void publishing.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(publishing).resolves.toBeUndefined()
  })

  it('does not publish a privileged in-memory acknowledgment hook', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk,
      callback?: () => void,
    ) => {
      callback?.()
      return true
    }) as typeof process.stdout.write)

    await publishPackageSmokeReport(report)
    expect(
      (
        globalThis as typeof globalThis & {
          __SUPRASPINA_PACKAGE_SMOKE__?: unknown
        }
      ).__SUPRASPINA_PACKAGE_SMOKE__,
    ).toBeUndefined()
  })
})
