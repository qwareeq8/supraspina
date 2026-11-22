/**
 * Coordinates deterministic packaged-application smoke checks.
 *
 * This module stays inert unless `index.ts` explicitly creates the coordinator
 * for an `app.isPackaged` process launched with `--supraspina-smoke-test`. The
 * coordinator then verifies the real ASAR, preload bridge, renderer, frozen
 * sidecar, update gate, and bundled fonts, and emits a path-free machine
 * report.
 */

import { accessSync, constants, lstatSync, type Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import type { BrowserWindow, Session } from 'electron'
import { version as APP_VERSION } from '../../package.json'
import { REQUIRED_SIDECAR_CAPABILITIES } from '../shared/contract'
import type { Sidecar } from './sidecar'

/** The command-line flag that enables packaged-smoke mode. */
export const PACKAGE_SMOKE_FLAG = '--supraspina-smoke-test'
/** The stdout prefix that identifies a packaged-smoke report. */
export const PACKAGE_SMOKE_SENTINEL = 'SUPRASPINA_PACKAGE_SMOKE_RESULT='
/** The harness-only marker for native PyBrainAge provisioning acceptance. */
export const NATIVE_SCIENCE_ACCEPTANCE_MARKER =
  'SUPRASPINA_NATIVE_SCIENCE_ACCEPTANCE'

const NO_SANDBOX_FLAG = '--no-sandbox'
const NO_SANDBOX_MARKER = 'SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX'
const SIDE_CAR_OVERRIDE = 'SUPRASPINA_SIDECAR'
const RENDERER_OVERRIDE = 'ELECTRON_RENDERER_URL'
/** The unreachable renderer override used to verify packaged isolation. */
export const PACKAGE_SMOKE_RENDERER_POISON = 'https://127.0.0.1:9/attacker'
const RENDERER_TIMEOUT_MS = 15_000
const SIDECAR_TIMEOUT_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 20_000
const REPORT_STDOUT_FLUSH_TIMEOUT_MS = 1_000
const NATIVE_SCIENCE_TIMEOUT_MS = 45 * 60 * 1_000

type PathKind = 'file' | 'directory' | 'missing' | 'other'

/** An abstraction over filesystem inspection for deterministic packaged-path checks. */
export interface PackageSmokePathAccess {
  kind(path: string): PathKind
  isExecutable(path: string): boolean
}

/** Packaged paths and launch context for topology checks. */
export interface PackageSmokePathInput {
  appPath: string
  resourcesPath: string
  rendererPath: string
  preloadPath: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}

/** The packaged resource-topology checks. */
export interface PackageSmokePathChecks {
  resourcesPathAbsolute: boolean
  appAsar: boolean
  rendererEntryInAsar: boolean
  preloadEntryInAsar: boolean
  externalIcon: boolean
  frozenSidecarLauncher: boolean
  frozenSidecarRuntime: boolean
  frozenSidecarExecutable: boolean
  bundledMicromamba: boolean
  bundledMicromambaExecutable: boolean
  noDeveloperOverrides: boolean
  rendererPoisonIgnored: boolean
  firstPartyLicense: boolean
  thirdPartyNotices: boolean
  thirdPartyProvenance: boolean
  dependencyManifests: boolean
  scientificAcquisitionMetadata: boolean
  unresolvedUpstreamAssetsExcluded: boolean
}

/** The complete packaged-launch acceptance matrix. */
export interface PackageSmokeChecks {
  packagedMode: boolean
  noSandboxPolicy: boolean
  resourcesPathAbsolute: boolean
  appAsar: boolean
  rendererEntryInAsar: boolean
  preloadEntryInAsar: boolean
  externalIcon: boolean
  frozenSidecarLauncher: boolean
  frozenSidecarRuntime: boolean
  frozenSidecarExecutable: boolean
  bundledMicromamba: boolean
  bundledMicromambaExecutable: boolean
  noDeveloperOverrides: boolean
  rendererPoisonIgnored: boolean
  firstPartyLicense: boolean
  thirdPartyNotices: boolean
  thirdPartyProvenance: boolean
  dependencyManifests: boolean
  scientificAcquisitionMetadata: boolean
  unresolvedUpstreamAssetsExcluded: boolean
  mainStarted: boolean
  rendererStarted: boolean
  preloadBridge: boolean
  rendererSandboxed: boolean
  hostIpcRoundTrip: boolean
  sidecarHandshake: boolean
  safeNoProject: boolean
  clinicalOpenpyxlRuntime: boolean
  clinicalDiscoveryDone: boolean
  clinicalRefreshDone: boolean
  clinicalMissingColumnsRejected: boolean
  clinicalEmptyRequiredRejected: boolean
  clinicalMalformedRejected: boolean
  clinicalMissingDependencyRejected: boolean
  clinicalLiveZeroExit: boolean
  clinicalReceiptDurable: boolean
  clinicalBrainpadEligible: boolean
  clinicalOutputReopened: boolean
  nativeScienceRequested: boolean
  pybrainageProvisioned: boolean
  pybrainageReady: boolean
  pybrainagePredictionReopened: boolean
  clinicalProjectDetached: boolean
  clinicalTemporaryDataRemoved: boolean
  updaterIdle: boolean
  noUpdateNetwork: boolean
  rendererLocalResources: boolean
  computerModernFaces: boolean
  fontSynthesisDisabled: boolean
  noProcessErrors: boolean
  noRendererErrors: boolean
  noSensitiveDiagnostics: boolean
  sidecarStopped: boolean
}

/** The path-free packaged-smoke failure categories. */
export type PackageSmokeFailureCode =
  | 'launch-policy'
  | 'packaged-paths'
  | 'sidecar-handshake'
  | 'renderer-start'
  | 'renderer-probe'
  | 'runtime-contract'
  | 'diagnostics'
  | 'shutdown'
  | null

/** The path-free packaged-smoke result emitted to the harness. */
export interface PackageSmokeReport {
  schemaVersion: 1
  productVersion: string
  sidecarProductVersion: string | null
  ok: boolean
  platform: NodeJS.Platform
  failureCode: PackageSmokeFailureCode
  checks: PackageSmokeChecks
}

/** Packaged paths and the supervised sidecar for the coordinator. */
export interface PackageSmokeRunInput {
  paths: PackageSmokePathInput
  sidecar: Pick<Sidecar, 'call' | 'getState' | 'start' | 'stop'>
}

interface ClinicalSmokeSession {
  token: string
  project: Record<string, unknown>
  cfg: Record<string, unknown>
  subjectId: string
  openpyxlRuntime: boolean
}

interface RendererProbe {
  rendererStarted: boolean
  preloadBridge: boolean
  rendererSandboxed: boolean
  rendererInAsar: boolean
  hostMode: unknown
  sidecarState: unknown
  sidecarGeneration: unknown
  sidecarProductVersion: unknown
  sidecarProtocolVersion: unknown
  sidecarCapabilities: unknown
  sidecarPersistenceCompatible: unknown
  sidecarRuntimeIdentityPresent: unknown
  sidecarProjectAttached: unknown
  safeNoProject: unknown
  updateCapability: unknown
  updatePhase: unknown
  remoteResourceCount: unknown
  resourcesAreLocal: unknown
  requestedFaceCount: unknown
  loadedFaceCount: unknown
  fontResourcesComplete: unknown
  fontResourcesLocal: unknown
  fontSynthesisNone: unknown
}

const defaultPathAccess: PackageSmokePathAccess = {
  kind(path): PathKind {
    let stats: Stats
    try {
      stats = lstatSync(path)
    } catch {
      return 'missing'
    }
    if (stats.isFile()) return 'file'
    if (stats.isDirectory()) return 'directory'
    return 'other'
  },
  isExecutable(path): boolean {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
}

/** Return true only for the exact, explicitly requested packaged smoke mode. */
export function isPackageSmokeMode(
  packaged: boolean,
  argv: readonly string[],
): boolean {
  return packaged && argv.includes(PACKAGE_SMOKE_FLAG)
}

/**
 * Validate the exceptional Linux CI sandbox opt-out.
 *
 * Never add `--no-sandbox` to normal launches. Require a smoke launch
 * that explicitly includes it to carry the harness-only marker and run under
 * Linux CI.
 *
 * @example
 * isPackageSmokeLaunchPolicySatisfied({
 *   enabled: true,
 *   argv: ['--no-sandbox'],
 *   platform: 'linux',
 *   env: { CI: 'true', SUPRASPINA_SMOKE_ALLOW_NO_SANDBOX: '1' },
 * })
 */
export function isPackageSmokeLaunchPolicySatisfied(input: {
  enabled: boolean
  argv: readonly string[]
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}): boolean {
  if (!input.argv.includes(NO_SANDBOX_FLAG)) return true
  const isCi = input.env['CI'] === 'true' || input.env['CI'] === '1'
  return (
    input.enabled &&
    input.platform === 'linux' &&
    isCi &&
    input.env[NO_SANDBOX_MARKER] === '1'
  )
}

/**
 * Inspect the canonical external-resource and ASAR topology without leaking it.
 */
export function inspectPackageSmokePaths(
  input: PackageSmokePathInput,
  access: PackageSmokePathAccess = defaultPathAccess,
): PackageSmokePathChecks {
  const appAsar = join(input.resourcesPath, 'app.asar')
  const rendererEntry = join(appAsar, 'out', 'renderer', 'index.html')
  const preloadEntry = join(appAsar, 'out', 'preload', 'index.cjs')
  const sidecarLauncher = join(
    input.resourcesPath,
    'sidecar',
    'supraspina-sidecar',
  )
  const sidecarRuntime = join(
    input.resourcesPath,
    'sidecar',
    'supraspina-runtime',
  )
  const bundledMicromamba = join(
    input.resourcesPath,
    'micromamba',
    'micromamba',
  )
  const sidecarResourceRoot = join(sidecarRuntime, 'resources')
  const pythonTarget = 'linux-x86_64'
  const dependencyDirectory = join(input.resourcesPath, 'dependency-manifests')
  const dependencyFiles = [
    'node-distributable.json',
    'node-third-party-notices.txt',
    `python-release-${pythonTarget}.cyclonedx.json`,
    `python-release-${pythonTarget}-notices.txt`,
    'package-lock.json',
    join('python-locks', `release-${pythonTarget}.txt`),
    join('python-locks', 'release-toolchain.json'),
  ]

  return {
    resourcesPathAbsolute: isAbsolute(input.resourcesPath),
    appAsar: input.appPath === appAsar,
    rendererEntryInAsar:
      input.rendererPath === rendererEntry &&
      access.kind(rendererEntry) === 'file',
    preloadEntryInAsar:
      input.preloadPath === preloadEntry &&
      access.kind(preloadEntry) === 'file',
    externalIcon: access.kind(join(input.resourcesPath, 'icon.png')) === 'file',
    frozenSidecarLauncher: access.kind(sidecarLauncher) === 'file',
    frozenSidecarRuntime: access.kind(sidecarRuntime) === 'directory',
    frozenSidecarExecutable: access.isExecutable(sidecarLauncher),
    bundledMicromamba: access.kind(bundledMicromamba) === 'file',
    bundledMicromambaExecutable:
      input.platform === 'win32' || access.isExecutable(bundledMicromamba),
    noDeveloperOverrides: !input.env[SIDE_CAR_OVERRIDE],
    rendererPoisonIgnored:
      input.env[RENDERER_OVERRIDE] === PACKAGE_SMOKE_RENDERER_POISON &&
      input.rendererPath === rendererEntry,
    firstPartyLicense:
      access.kind(join(input.resourcesPath, 'LICENSE')) === 'file',
    thirdPartyNotices:
      access.kind(join(input.resourcesPath, 'THIRD_PARTY_NOTICES')) === 'file',
    thirdPartyProvenance:
      access.kind(join(input.resourcesPath, 'THIRD_PARTY_PROVENANCE.json')) ===
      'file',
    dependencyManifests: dependencyFiles.every(
      (relative) => access.kind(join(dependencyDirectory, relative)) === 'file',
    ),
    scientificAcquisitionMetadata:
      access.kind(
        join(sidecarRuntime, 'metadata', 'THIRD_PARTY_PROVENANCE.json'),
      ) === 'file' &&
      access.kind(
        join(sidecarRuntime, 'metadata', 'SCIENTIFIC_RESOURCE_PINS.json'),
      ) === 'file' &&
      access.kind(join(sidecarResourceRoot, 'step7', 'brainpadstats.py')) ===
        'file' &&
      access.kind(
        join(sidecarResourceRoot, 'brainfov', 'brainfov_helper.py'),
      ) === 'file',
    unresolvedUpstreamAssetsExcluded:
      access.kind(
        join(sidecarResourceRoot, 'enigma', 'compiled', 'FS_external_QC'),
      ) === 'missing' &&
      access.kind(
        join(sidecarResourceRoot, 'features', 'rois_input_template.txt'),
      ) === 'missing' &&
      access.kind(join(input.resourcesPath, 'scientific-resources')) ===
        'missing' &&
      access.kind(join(sidecarResourceRoot, 'scientific-resources')) ===
        'missing',
  }
}

/**
 * Return true only when every path check proves the frozen runtime topology.
 */
export function packageSmokePathsAreValid(
  checks: PackageSmokePathChecks,
): boolean {
  return Object.values(checks).every(Boolean)
}

function emptyChecks(): PackageSmokeChecks {
  return {
    packagedMode: false,
    noSandboxPolicy: false,
    resourcesPathAbsolute: false,
    appAsar: false,
    rendererEntryInAsar: false,
    preloadEntryInAsar: false,
    externalIcon: false,
    frozenSidecarLauncher: false,
    frozenSidecarRuntime: false,
    frozenSidecarExecutable: false,
    bundledMicromamba: false,
    bundledMicromambaExecutable: false,
    noDeveloperOverrides: false,
    rendererPoisonIgnored: false,
    firstPartyLicense: false,
    thirdPartyNotices: false,
    thirdPartyProvenance: false,
    dependencyManifests: false,
    scientificAcquisitionMetadata: false,
    unresolvedUpstreamAssetsExcluded: false,
    mainStarted: false,
    rendererStarted: false,
    preloadBridge: false,
    rendererSandboxed: false,
    hostIpcRoundTrip: false,
    sidecarHandshake: false,
    safeNoProject: false,
    clinicalOpenpyxlRuntime: false,
    clinicalDiscoveryDone: false,
    clinicalRefreshDone: false,
    clinicalMissingColumnsRejected: false,
    clinicalEmptyRequiredRejected: false,
    clinicalMalformedRejected: false,
    clinicalMissingDependencyRejected: false,
    clinicalLiveZeroExit: false,
    clinicalReceiptDurable: false,
    clinicalBrainpadEligible: false,
    clinicalOutputReopened: false,
    nativeScienceRequested: false,
    pybrainageProvisioned: false,
    pybrainageReady: false,
    pybrainagePredictionReopened: false,
    clinicalProjectDetached: false,
    clinicalTemporaryDataRemoved: false,
    updaterIdle: false,
    noUpdateNetwork: false,
    rendererLocalResources: false,
    computerModernFaces: false,
    fontSynthesisDisabled: false,
    noProcessErrors: false,
    noRendererErrors: false,
    noSensitiveDiagnostics: false,
    sidecarStopped: false,
  }
}

/**
 * Detect path, study-identity, and credential material in diagnostics.
 *
 * Keep successful reports free of diagnostic fields. Use this scan as a
 * second fail-closed guard for observed process/renderer messages and for the
 * serialized report itself.
 */
export function containsSensitiveSmokeDiagnostic(value: unknown): boolean {
  let text: string
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

/** Reject reports that expose sensitive diagnostic material. */
export function packageSmokeReportIsSafe(report: unknown): boolean {
  return !containsSensitiveSmokeDiagnostic(report)
}

function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: Exclude<PackageSmokeFailureCode, null>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        reject(new Error(code))
      },
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRendererProbe(value: unknown): RendererProbe | null {
  if (!isRecord(value)) return null
  return value as unknown as RendererProbe
}

function parseClinicalSession(value: unknown): ClinicalSmokeSession | null {
  if (
    !isRecord(value) ||
    typeof value.token !== 'string' ||
    value.token.length === 0 ||
    !isRecord(value.project) ||
    !isRecord(value.cfg) ||
    typeof value.subjectId !== 'string' ||
    value.subjectId.length === 0 ||
    typeof value.openpyxlRuntime !== 'boolean'
  ) {
    return null
  }
  return {
    token: value.token,
    project: value.project,
    cfg: value.cfg,
    subjectId: value.subjectId,
    openpyxlRuntime: value.openpyxlRuntime,
  }
}

function clinicalState(value: unknown, subjectId: string): string | null {
  if (!Array.isArray(value)) return null
  const subject = value.find(
    (candidate) => isRecord(candidate) && candidate.id === subjectId,
  )
  if (!isRecord(subject) || !isRecord(subject.stepStates)) return null
  return typeof subject.stepStates.clinical === 'string'
    ? subject.stepStates.clinical
    : null
}

function refreshedClinicalState(
  value: unknown,
  subjectId: string,
): string | null {
  if (
    !isRecord(value) ||
    value.id !== subjectId ||
    !isRecord(value.stepStates)
  ) {
    return null
  }
  return typeof value.stepStates.clinical === 'string'
    ? value.stepStates.clinical
    : null
}

function booleanField(value: unknown, name: string): boolean {
  return isRecord(value) && value[name] === true
}

function stringField(value: unknown, name: string): string | null {
  if (!isRecord(value)) return null
  const field = value[name]
  return typeof field === 'string' && field.length > 0 && field.length <= 256
    ? field
    : null
}

const NATIVE_SCIENCE_CHECKS = new Set<keyof PackageSmokeChecks>([
  'nativeScienceRequested',
  'pybrainageProvisioned',
  'pybrainageReady',
  'pybrainagePredictionReopened',
])

/** Return whether all ordinary and explicitly requested native checks passed. */
export function packageSmokeChecksPass(checks: PackageSmokeChecks): boolean {
  const ordinary = Object.entries(checks).every(
    ([name, passed]) =>
      NATIVE_SCIENCE_CHECKS.has(name as keyof PackageSmokeChecks) || passed,
  )
  return (
    ordinary &&
    (!checks.nativeScienceRequested ||
      (checks.pybrainageProvisioned &&
        checks.pybrainageReady &&
        checks.pybrainagePredictionReopened))
  )
}

function sidecarHandshakeReady(
  state: ReturnType<PackageSmokeRunInput['sidecar']['getState']>,
): boolean {
  const persistence = state.persistenceVersions
  return (
    state.state === 'ready' &&
    state.generation >= 1 &&
    state.productVersion === APP_VERSION &&
    state.protocolVersion === '1' &&
    state.runtimeId !== null &&
    state.runtimeId.length > 0 &&
    state.projectAttached === false &&
    persistence?.project === 1 &&
    persistence.runState === 1 &&
    persistence.manifest === 1 &&
    persistence.receipt === 1 &&
    REQUIRED_SIDECAR_CAPABILITIES.every((capability) =>
      state.capabilities.includes(capability),
    )
  )
}

function applyRendererProbe(
  checks: PackageSmokeChecks,
  probe: RendererProbe,
  sidecarState: ReturnType<PackageSmokeRunInput['sidecar']['getState']>,
  remoteNetworkAttempts: number,
): void {
  const rendererCapabilities = Array.isArray(probe.sidecarCapabilities)
    ? probe.sidecarCapabilities
    : []
  checks.rendererStarted = probe.rendererStarted === true
  checks.preloadBridge = probe.preloadBridge === true
  checks.rendererSandboxed = probe.rendererSandboxed === true
  checks.hostIpcRoundTrip =
    probe.hostMode === 'electron' &&
    probe.sidecarState === 'ready' &&
    probe.sidecarGeneration === sidecarState.generation &&
    probe.sidecarProductVersion === sidecarState.productVersion &&
    probe.sidecarProductVersion === APP_VERSION &&
    probe.sidecarProtocolVersion === sidecarState.protocolVersion &&
    probe.sidecarProjectAttached === false
  checks.sidecarHandshake =
    checks.sidecarHandshake &&
    probe.sidecarPersistenceCompatible === true &&
    probe.sidecarRuntimeIdentityPresent === true &&
    REQUIRED_SIDECAR_CAPABILITIES.every((capability) =>
      rendererCapabilities.includes(capability),
    )
  checks.safeNoProject =
    probe.safeNoProject === true && probe.sidecarProjectAttached === false
  // A packaged build resolves a real capability, and the smoke run makes no
  // launch check, so the updater stays idle and off the network.
  checks.updaterIdle =
    (probe.updateCapability === 'full' ||
      probe.updateCapability === 'notify') &&
    probe.updatePhase === 'idle'
  checks.noUpdateNetwork =
    checks.updaterIdle &&
    remoteNetworkAttempts === 0 &&
    probe.remoteResourceCount === 0
  checks.rendererLocalResources =
    probe.rendererInAsar === true && probe.resourcesAreLocal === true
  checks.computerModernFaces =
    probe.requestedFaceCount === 18 &&
    probe.loadedFaceCount === 18 &&
    probe.fontResourcesComplete === true &&
    probe.fontResourcesLocal === true
  checks.fontSynthesisDisabled = probe.fontSynthesisNone === true
}

const RENDERER_PROBE_SOURCE = String.raw`
(async () => {
  const bridge = globalThis.supraspina;
  const preloadBridge = Boolean(
    bridge &&
      bridge.__mock !== true &&
      bridge.host &&
      typeof bridge.host.getState === "function" &&
      bridge.update &&
      typeof bridge.update.check === "function" &&
      typeof bridge.update.getStatus === "function"
  );
  if (!preloadBridge) throw new Error("renderer-probe");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const root = globalThis.document.querySelector("#root");
    if (root && root.childElementCount > 0) break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
  }

  const host = await bridge.host.getState();
  const update = await bridge.update.getStatus();
  const faces = [
    ["sans-400-normal", "normal", 400, "WebCM Sans 10", "WebCM Sans 10 Regular"],
    ["sans-400-italic", "italic", 400, "WebCM Sans 10", "WebCM Sans 10 Oblique"],
    ["sans-500-normal", "normal", 500, "WebCM Sans 10", "WebCM Sans 10 Book"],
    ["sans-500-italic", "italic", 500, "WebCM Sans 10", "WebCM Sans 10 BookOblique"],
    ["sans-700-normal", "normal", 700, "WebCM Sans 10", "WebCM Sans 10 Bold"],
    ["sans-700-italic", "italic", 700, "WebCM Sans 10", "WebCM Sans 10 BoldOblique"],
    ["serif-400-normal", "normal", 400, "WebCM Serif 10", "WebCM Serif 10 Regular"],
    ["serif-400-italic", "italic", 400, "WebCM Serif 10", "WebCM Serif 10 Italic"],
    ["serif-500-normal", "normal", 500, "WebCM Serif 10", "WebCM Serif 10 Book"],
    ["serif-500-italic", "italic", 500, "WebCM Serif 10", "WebCM Serif 10 BookItalic"],
    ["serif-700-normal", "normal", 700, "WebCM Serif 10", "WebCM Serif 10 Bold"],
    ["serif-700-italic", "italic", 700, "WebCM Serif 10", "WebCM Serif 10 BoldItalic"],
    ["mono-400-normal", "normal", 400, "WebCM Mono 10", "WebCM Mono 10 Regular"],
    ["mono-400-italic", "italic", 400, "WebCM Mono 10", "WebCM Mono 10 Italic"],
    ["mono-500-normal", "normal", 500, "WebCM Mono 10", "WebCM Mono 10 Book"],
    ["mono-500-italic", "italic", 500, "WebCM Mono 10", "WebCM Mono 10 BookItalic"],
    ["mono-700-normal", "normal", 700, "WebCM Mono 10", "WebCM Mono 10 Bold"],
    ["mono-700-italic", "italic", 700, "WebCM Mono 10", "WebCM Mono 10 BoldOblique"],
  ];
  const descriptors = faces.map(
    (face) => face[1] + " " + face[2] + " 16px \"" + face[3] + "\""
  );
  const loaded = await Promise.all(
    descriptors.map((descriptor) =>
      globalThis.document.fonts.load(descriptor, "Supraspina")
    )
  );
  await globalThis.document.fonts.ready;
  const loadedFaceCount = loaded.filter((matches, index) => {
    const face = faces[index];
    return (
      matches.length === 1 &&
      matches[0].status === "loaded" &&
      matches[0].family.replace(/^["']|["']$/g, "") === face[3] &&
      Number(matches[0].weight) === face[2] &&
      matches[0].style === face[1] &&
      globalThis.document.fonts.check(descriptors[index], "Supraspina")
    );
  }).length;
  const activation = globalThis.document.querySelector(
    '[data-font-activation="fonts-18"]'
  );
  const activationSpecimens = activation
    ? [...activation.querySelectorAll("[data-font-face]")]
    : [];
  const activationSpecimensComplete =
    activationSpecimens.length === faces.length &&
    faces.every((face) => {
      const specimen = activation.querySelector(
        '[data-font-face="' + face[0] + '"]'
      );
      if (!specimen) return false;
      const style = globalThis.getComputedStyle(specimen);
      const primaryFamily = style.fontFamily
        .split(",")[0]
        .trim()
        .replace(/^["']|["']$/g, "");
      return (
        primaryFamily === face[3] &&
        Number(style.fontWeight) === face[2] &&
        style.fontStyle === face[1]
      );
    });

  const resources = globalThis.performance
    .getEntriesByType("resource")
    .map((entry) => new URL(entry.name));
  const fontRules = [...globalThis.document.styleSheets]
    .flatMap((sheet) => [...sheet.cssRules])
    .filter((rule) => rule.type === globalThis.CSSRule.FONT_FACE_RULE);
  const fontRuleSources = fontRules.map((rule) => {
    const source = rule.style.getPropertyValue("src");
    const match = source.match(/url\(["']?([^"')]+)["']?\)/);
    return {
      family: rule.style
        .getPropertyValue("font-family")
        .trim()
        .replace(/^["']|["']$/g, ""),
      weight: Number(rule.style.getPropertyValue("font-weight")),
      style: rule.style.getPropertyValue("font-style").trim(),
      source,
      url: match ? new URL(match[1], globalThis.location.href) : null,
    };
  });
  const fontResourcesComplete =
    fontRuleSources.length === faces.length &&
    new Set(fontRuleSources.map((rule) => rule.url?.href)).size ===
      faces.length &&
    faces.every((face) =>
      fontRuleSources.some((rule) => {
        const name = decodeURIComponent(
          rule.url?.pathname.split("/").pop() || ""
        );
        return (
          rule.family === face[3] &&
          rule.weight === face[2] &&
          rule.style === face[1] &&
          /format\(["']?woff2["']?\)/.test(rule.source) &&
          name.startsWith(face[4] + "-") &&
          name.endsWith(".woff2")
        );
      })
    ) &&
    activationSpecimensComplete;
  const rootStyle = globalThis.getComputedStyle(
    globalThis.document.documentElement
  );
  const root = globalThis.document.querySelector("#root");
  const rendererPath = decodeURIComponent(globalThis.location.pathname);
  const persistence = host.sidecar.persistenceVersions;

  return {
    rendererStarted:
      globalThis.document.title === "Supraspina" &&
      Boolean(root && root.childElementCount > 0),
    preloadBridge,
    rendererSandboxed:
      typeof globalThis.process === "undefined" &&
      typeof globalThis.require === "undefined",
    rendererInAsar:
      globalThis.location.protocol === "file:" &&
      rendererPath.includes("/app.asar/out/renderer/index.html"),
    hostMode: host.mode,
    sidecarState: host.sidecar.state,
    sidecarGeneration: host.sidecar.generation,
    sidecarProductVersion: host.sidecar.productVersion,
    sidecarProtocolVersion: host.sidecar.protocolVersion,
    sidecarCapabilities: host.sidecar.capabilities,
    sidecarPersistenceCompatible: Boolean(
      persistence &&
        persistence.project === 1 &&
        persistence.runState === 1 &&
        persistence.manifest === 1 &&
        persistence.receipt === 1
    ),
    sidecarRuntimeIdentityPresent:
      typeof host.sidecar.runtimeId === "string" &&
      host.sidecar.runtimeId.length > 0,
    sidecarProjectAttached: host.sidecar.projectAttached,
    safeNoProject:
      host.sidecar.projectAttached === false &&
      globalThis.localStorage.getItem("supraspinaRecentProjects") === null &&
      Boolean(
        globalThis.document.querySelector(
          'button[aria-label="Open a saved project"]'
        )
      ),
    updateCapability: update.capability,
    updatePhase: update.phase,
    remoteResourceCount: resources.filter(
      (resource) =>
        resource.protocol === "http:" || resource.protocol === "https:"
    ).length,
    resourcesAreLocal: resources.every(
      (resource) =>
        resource.protocol === "file:" || resource.protocol === "data:"
    ),
    requestedFaceCount: faces.length,
    loadedFaceCount:
      globalThis.document.fonts.status === "loaded" ? loadedFaceCount : 0,
    fontResourcesComplete,
    fontResourcesLocal:
      fontRuleSources.length === faces.length &&
      fontRuleSources.every(
        (rule) =>
          rule.url?.protocol === "file:" &&
          rule.url.pathname.includes("/app.asar/out/renderer/")
      ),
    fontSynthesisNone:
      rootStyle.getPropertyValue("font-synthesis").trim() === "none",
  };
})()
`

/** The coordinator for the packaged application acceptance probe. */
export class PackageSmokeCoordinator {
  private window: BrowserWindow | null = null
  private rendererLoaded: Promise<void> | null = null
  private disposed = false
  private processErrorCount = 0
  private rendererErrorCount = 0
  private sensitiveDiagnosticCount = 0
  private remoteNetworkAttempts = 0

  private readonly uncaughtExceptionHandler = (error: Error): void => {
    this.processErrorCount += 1
    if (containsSensitiveSmokeDiagnostic(error)) {
      this.sensitiveDiagnosticCount += 1
    }
  }

  private readonly unhandledRejectionHandler = (reason: unknown): void => {
    this.processErrorCount += 1
    if (containsSensitiveSmokeDiagnostic(reason)) {
      this.sensitiveDiagnosticCount += 1
    }
  }

  public constructor(
    private readonly invocation: {
      enabled: boolean
      argv: readonly string[]
      platform: NodeJS.Platform
      env: NodeJS.ProcessEnv
    },
  ) {
    process.on('uncaughtException', this.uncaughtExceptionHandler)
    process.on('unhandledRejection', this.unhandledRejectionHandler)
  }

  /** Release process-wide observers safely, even when called more than once. */
  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    process.off('uncaughtException', this.uncaughtExceptionHandler)
    process.off('unhandledRejection', this.unhandledRejectionHandler)
  }

  /** Attach diagnostics before the first renderer navigation begins. */
  public observeWindow(window: BrowserWindow, updaterSession: Session): void {
    this.window = window
    this.rendererLoaded = new Promise<void>((resolve, reject) => {
      window.webContents.once('did-finish-load', () => resolve())
      window.webContents.on(
        'did-fail-load',
        (_event, _errorCode, _description, _url, isMainFrame) => {
          if (!isMainFrame) return
          this.rendererErrorCount += 1
          reject(new Error('renderer-start'))
        },
      )
    })

    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') this.rendererErrorCount += 1
      if (containsSensitiveSmokeDiagnostic(details.message)) {
        this.sensitiveDiagnosticCount += 1
      }
    })
    window.webContents.on('preload-error', () => {
      this.rendererErrorCount += 1
    })
    window.webContents.on('render-process-gone', () => {
      this.rendererErrorCount += 1
    })
    window.on('unresponsive', () => {
      this.rendererErrorCount += 1
    })

    for (const targetSession of [window.webContents.session, updaterSession]) {
      targetSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (_details, callback) => {
          this.remoteNetworkAttempts += 1
          callback({ cancel: true })
        },
      )
    }
  }

  /** Run all checks, always attempting authoritative sidecar shutdown. */
  public async run(input: PackageSmokeRunInput): Promise<PackageSmokeReport> {
    const checks = emptyChecks()
    checks.nativeScienceRequested =
      this.invocation.env[NATIVE_SCIENCE_ACCEPTANCE_MARKER] === '1'
    const pathChecks = inspectPackageSmokePaths(input.paths)
    Object.assign(checks, pathChecks)
    checks.packagedMode = this.invocation.enabled
    checks.mainStarted = true
    checks.noSandboxPolicy = isPackageSmokeLaunchPolicySatisfied(
      this.invocation,
    )

    let failureCode: PackageSmokeFailureCode = null
    let clinicalSession: ClinicalSmokeSession | null = null
    let sidecarProductVersion: string | null = null
    try {
      if (!checks.noSandboxPolicy) throw new Error('launch-policy')
      if (!packageSmokePathsAreValid(pathChecks)) {
        throw new Error('packaged-paths')
      }

      await bounded(
        input.sidecar.start(),
        SIDECAR_TIMEOUT_MS,
        'sidecar-handshake',
      )
      const sidecarState = input.sidecar.getState()
      sidecarProductVersion = sidecarState.productVersion
      if (containsSensitiveSmokeDiagnostic(sidecarState.detail)) {
        this.sensitiveDiagnosticCount += 1
      }
      checks.sidecarHandshake = sidecarHandshakeReady(sidecarState)
      if (!checks.sidecarHandshake) throw new Error('sidecar-handshake')

      const rawClinicalSession = await bounded(
        input.sidecar.call('system.packageSmokeClinicalSetup', []),
        SIDECAR_TIMEOUT_MS,
        'runtime-contract',
      )
      clinicalSession = parseClinicalSession(rawClinicalSession)
      if (!clinicalSession) throw new Error('runtime-contract')
      checks.clinicalOpenpyxlRuntime = clinicalSession.openpyxlRuntime
      const projectRequest = {
        project: clinicalSession.project,
        cfg: clinicalSession.cfg,
        configRevision: 0,
      }
      const discovered = await bounded(
        input.sidecar.call('subjects.discover', [projectRequest]),
        SIDECAR_TIMEOUT_MS,
        'runtime-contract',
      )
      checks.clinicalDiscoveryDone =
        clinicalState(discovered, clinicalSession.subjectId) === 'done'
      const refreshed = await bounded(
        input.sidecar.call('subjects.refreshOne', [
          { ...projectRequest, subjectId: clinicalSession.subjectId },
        ]),
        SIDECAR_TIMEOUT_MS,
        'runtime-contract',
      )
      checks.clinicalRefreshDone =
        refreshedClinicalState(refreshed, clinicalSession.subjectId) === 'done'

      const verifyRejectedCase = async (
        name: 'missing-columns' | 'empty-required' | 'malformed',
      ): Promise<boolean> => {
        const applied = await bounded(
          input.sidecar.call('system.packageSmokeClinicalCase', [
            { token: clinicalSession!.token, case: name },
          ]),
          SIDECAR_TIMEOUT_MS,
          'runtime-contract',
        )
        const caseRefresh = await bounded(
          input.sidecar.call('subjects.refreshOne', [
            { ...projectRequest, subjectId: clinicalSession!.subjectId },
          ]),
          SIDECAR_TIMEOUT_MS,
          'runtime-contract',
        )
        return (
          booleanField(applied, 'caseApplied') &&
          refreshedClinicalState(caseRefresh, clinicalSession!.subjectId) ===
            'pending'
        )
      }
      checks.clinicalMissingColumnsRejected =
        await verifyRejectedCase('missing-columns')
      checks.clinicalEmptyRequiredRejected =
        await verifyRejectedCase('empty-required')
      checks.clinicalMalformedRejected = await verifyRejectedCase('malformed')

      const missingDependency = await bounded(
        input.sidecar.call('system.packageSmokeClinicalCase', [
          { token: clinicalSession.token, case: 'missing-dependency' },
        ]),
        SIDECAR_TIMEOUT_MS,
        'runtime-contract',
      )
      checks.clinicalMissingDependencyRejected =
        booleanField(missingDependency, 'caseApplied') &&
        booleanField(missingDependency, 'dependencyRejected')
      const restored = await bounded(
        input.sidecar.call('system.packageSmokeClinicalCase', [
          { token: clinicalSession.token, case: 'valid' },
        ]),
        SIDECAR_TIMEOUT_MS,
        'runtime-contract',
      )
      if (!booleanField(restored, 'caseApplied')) {
        throw new Error('runtime-contract')
      }
      const startedExecution = await bounded(
        input.sidecar.call('system.packageSmokeClinicalExecute', [
          { token: clinicalSession.token },
        ]),
        SIDECAR_TIMEOUT_MS,
        'runtime-contract',
      )
      if (!booleanField(startedExecution, 'started')) {
        throw new Error('runtime-contract')
      }
      const executionDeadline = Date.now() + SIDECAR_TIMEOUT_MS
      let execution: unknown = null
      while (Date.now() < executionDeadline) {
        const status = await bounded(
          input.sidecar.call('system.packageSmokeClinicalExecutionStatus', [
            { token: clinicalSession.token },
          ]),
          SIDECAR_TIMEOUT_MS,
          'runtime-contract',
        )
        if (booleanField(status, 'complete')) {
          execution = status
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (execution === null) throw new Error('runtime-contract')
      checks.clinicalLiveZeroExit = booleanField(execution, 'liveZeroExit')
      checks.clinicalReceiptDurable = booleanField(execution, 'durableReceipt')
      checks.clinicalBrainpadEligible = booleanField(
        execution,
        'dependentEligible',
      )
      checks.clinicalOutputReopened = booleanField(execution, 'outputReopened')
      if (checks.nativeScienceRequested) {
        const authorization = {
          token: randomUUID(),
          projectId: String(clinicalSession.project['projectId'] ?? ''),
          configRevision: 0,
          purpose: 'provision',
        }
        const started = await bounded(
          input.sidecar.call('provision.pybrainage', [
            { ...projectRequest, authorization },
          ]),
          SIDECAR_TIMEOUT_MS,
          'runtime-contract',
        )
        const operationId = stringField(started, 'operationId')
        if (!operationId) throw new Error('runtime-contract')
        const deadline = Date.now() + NATIVE_SCIENCE_TIMEOUT_MS
        let provisionStatus: unknown = null
        while (Date.now() < deadline) {
          provisionStatus = await bounded(
            input.sidecar.call('provision.status', [projectRequest]),
            SIDECAR_TIMEOUT_MS,
            'runtime-contract',
          )
          const phase = stringField(provisionStatus, 'phase')
          if (phase !== 'running') break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        checks.pybrainageProvisioned =
          stringField(provisionStatus, 'phase') === 'done'
        checks.pybrainageReady =
          checks.pybrainageProvisioned &&
          booleanField(provisionStatus, 'envReady') &&
          booleanField(provisionStatus, 'modelReady')
        if (!checks.pybrainageReady) throw new Error('runtime-contract')
        const prediction = await bounded(
          input.sidecar.call('system.packageSmokePybrainageExecute', [
            { token: clinicalSession.token },
          ]),
          10 * 60 * 1_000,
          'runtime-contract',
        )
        checks.pybrainagePredictionReopened =
          booleanField(prediction, 'zeroExit') &&
          booleanField(prediction, 'outputReopened')
        if (!checks.pybrainagePredictionReopened) {
          throw new Error('runtime-contract')
        }
      }
      const clinicalCleanup = await bounded(
        input.sidecar.call('system.packageSmokeClinicalCleanup', [
          { token: clinicalSession.token },
        ]),
        SIDECAR_TIMEOUT_MS,
        'runtime-contract',
      )
      checks.clinicalProjectDetached = booleanField(
        clinicalCleanup,
        'projectDetached',
      )
      checks.clinicalTemporaryDataRemoved = booleanField(
        clinicalCleanup,
        'temporaryDataRemoved',
      )
      clinicalSession = null

      if (!this.rendererLoaded || !this.window) {
        throw new Error('renderer-start')
      }
      await bounded(this.rendererLoaded, RENDERER_TIMEOUT_MS, 'renderer-start')
      const rawProbe = await bounded(
        this.window.webContents.executeJavaScript(RENDERER_PROBE_SOURCE, true),
        RENDERER_TIMEOUT_MS,
        'renderer-probe',
      )
      const probe = parseRendererProbe(rawProbe)
      if (!probe) throw new Error('renderer-probe')
      applyRendererProbe(
        checks,
        probe,
        sidecarState,
        this.remoteNetworkAttempts,
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch (error) {
      const code = error instanceof Error ? error.message : 'runtime-contract'
      failureCode = isFailureCode(code) ? code : 'runtime-contract'
    } finally {
      if (clinicalSession) {
        try {
          const cleanup = await bounded(
            input.sidecar.call('system.packageSmokeClinicalCleanup', [
              { token: clinicalSession.token },
            ]),
            SIDECAR_TIMEOUT_MS,
            'runtime-contract',
          )
          checks.clinicalProjectDetached = booleanField(
            cleanup,
            'projectDetached',
          )
          checks.clinicalTemporaryDataRemoved = booleanField(
            cleanup,
            'temporaryDataRemoved',
          )
        } catch {
          checks.clinicalProjectDetached = false
          checks.clinicalTemporaryDataRemoved = false
          if (failureCode === null) failureCode = 'runtime-contract'
        }
      }
      try {
        await bounded(input.sidecar.stop(), SHUTDOWN_TIMEOUT_MS, 'shutdown')
        const stoppedState = input.sidecar.getState()
        if (containsSensitiveSmokeDiagnostic(stoppedState.detail)) {
          this.sensitiveDiagnosticCount += 1
        }
        checks.sidecarStopped =
          stoppedState.state === 'unavailable' &&
          stoppedState.projectAttached === false
      } catch {
        checks.sidecarStopped = false
        failureCode = 'shutdown'
      }
      this.dispose()
    }

    checks.noProcessErrors = this.processErrorCount === 0
    checks.noRendererErrors = this.rendererErrorCount === 0
    checks.noSensitiveDiagnostics = this.sensitiveDiagnosticCount === 0
    checks.noUpdateNetwork =
      checks.noUpdateNetwork && this.remoteNetworkAttempts === 0
    const ok = packageSmokeChecksPass(checks)
    if (!ok && failureCode === null) {
      failureCode =
        checks.noProcessErrors &&
        checks.noRendererErrors &&
        checks.noSensitiveDiagnostics
          ? 'runtime-contract'
          : 'diagnostics'
    }

    const report: PackageSmokeReport = {
      schemaVersion: 1,
      productVersion: APP_VERSION,
      sidecarProductVersion,
      ok,
      platform: this.invocation.platform,
      failureCode,
      checks,
    }
    if (!packageSmokeReportIsSafe(report)) {
      checks.noSensitiveDiagnostics = false
      report.ok = false
      report.failureCode = 'diagnostics'
    }
    return report
  }
}

function isFailureCode(
  value: string,
): value is Exclude<PackageSmokeFailureCode, null> {
  return [
    'launch-policy',
    'packaged-paths',
    'sidecar-handshake',
    'renderer-start',
    'renderer-probe',
    'runtime-contract',
    'diagnostics',
    'shutdown',
  ].includes(value)
}

/**
 * Write the one stable, path-free line consumed by the direct launch harness.
 *
 * @returns Resolves after stdout accepts the report or the flush bound expires.
 */
export function emitPackageSmokeReport(
  report: PackageSmokeReport,
): Promise<void> {
  const line = `${PACKAGE_SMOKE_SENTINEL}${JSON.stringify(report)}\n`
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve()
    }
    try {
      process.stdout.write(line, finish)
    } catch {
      finish()
    }
    if (!settled) {
      timer = setTimeout(finish, REPORT_STDOUT_FLUSH_TIMEOUT_MS)
    }
  })
}

/**
 * Publish after the direct-spawn harness attaches stdout.
 *
 * @returns Resolves after the report publication attempt completes.
 */
export async function publishPackageSmokeReport(
  report: PackageSmokeReport,
): Promise<void> {
  await emitPackageSmokeReport(report)
}
