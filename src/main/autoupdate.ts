/**
 * Orchestrates in-app updates from the public GitHub Releases through
 * electron-updater.
 *
 * Capability resolves once per process: development and source runs stay
 * network-inert, packaged AppImages can download and install an update, and
 * every other packaged format, such as the Debian package, only reports a new
 * version and links its release page. A launch check runs at most once a day
 * while the automatic-check preference is on; a manual check runs only when
 * the operator asks. Update bytes download only after the operator confirms an
 * offered version, and electron-updater verifies them against the SHA-512 in
 * `latest-linux.yml` before installation. Every state transition is published
 * to the owning window, and `getStatus()` serves late subscribers.
 */

import process from 'node:process'
import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import log from 'electron-log'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import type { UpdateCheckResult, UpdateState } from '../shared/contract'

// Import electron-updater through its CommonJS default export to keep the
// externalized ESM main process loadable. Resolve autoUpdater lazily so
// importing this module remains free of Electron app side effects.
let autoUpdaterCache: typeof electronUpdater.autoUpdater | null = null
function updater(): typeof electronUpdater.autoUpdater {
  autoUpdaterCache ??= electronUpdater.autoUpdater
  return autoUpdaterCache
}

/** The update behavior available to the current package. */
export type UpdateCapability = UpdateState['capability']

/** The shortest interval between two automatic launch checks. */
export const AUTOMATIC_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Resolve capability without Electron globals.
 *
 * @returns `noop` outside a packaged Linux build, `full` for an AppImage, and
 *   `notify` for every other packaged format.
 */
export function resolveCapability(opts: {
  packaged: boolean
  platform: NodeJS.Platform
  appImage: boolean
}): UpdateCapability {
  // Keep electron-vite development and source runs off the network.
  if (!opts.packaged || opts.platform !== 'linux') return 'noop'
  // Replace only the AppImage file in place. An installed Debian package
  // would need root through pkexec or sudo, so it stays manual.
  return opts.appImage ? 'full' : 'notify'
}

/**
 * Say whether an automatic launch check is due.
 *
 * @param lastCheckedAt - The last check time in epoch milliseconds, or null
 *   when no check has run.
 * @param now - The current time in epoch milliseconds.
 * @returns True when a day has passed since the last check.
 */
export function automaticCheckDue(
  lastCheckedAt: number | null,
  now: number,
): boolean {
  if (lastCheckedAt === null) return true
  // A clock set back leaves a future time on disk; check instead of waiting.
  if (lastCheckedAt > now) return true
  return now - lastCheckedAt >= AUTOMATIC_CHECK_INTERVAL_MS
}

function platformCapability(): UpdateCapability {
  return resolveCapability({
    packaged: app.isPackaged,
    platform: process.platform,
    appImage: typeof process.env['APPIMAGE'] === 'string',
  })
}

// Cache capability on first use to keep module import free of Electron app
// side effects.
let capabilityCache: UpdateCapability | null = null

function capability(): UpdateCapability {
  capabilityCache ??= platformCapability()
  return capabilityCache
}

/**
 * Normalize electron-updater's `releaseNotes` (string, list, or null) to a
 * single string for the renderer.
 */
function notesToText(
  notes: string | { version: string; note: string | null }[] | null | undefined,
): string | null {
  if (notes == null) return null
  if (typeof notes === 'string') return notes
  return (
    notes
      .map((entry) => entry.note ?? '')
      .filter((note) => note !== '')
      .join('\n\n') || null
  )
}

function redactUpdateDiagnostic(value: unknown): string {
  void value
  return 'Review the redacted update diagnostic.'
}

const redactedUpdaterLogger = {
  info: (...args: unknown[]): void =>
    log.info(...args.map(redactUpdateDiagnostic)),
  warn: (...args: unknown[]): void =>
    log.warn(...args.map(redactUpdateDiagnostic)),
  error: (...args: unknown[]): void =>
    log.error(...args.map(redactUpdateDiagnostic)),
  debug: (...args: unknown[]): void =>
    log.debug(...args.map(redactUpdateDiagnostic)),
}

function emptyResult(): UpdateCheckResult {
  return { available: false, version: null, releaseNotes: null }
}

type Updater = typeof electronUpdater.autoUpdater

/** Capability-gated update operations exposed to privileged IPC. */
export interface AutoUpdateApi {
  check(): Promise<UpdateCheckResult>
  checkOnLaunch(): Promise<boolean>
  download(): Promise<void>
  canInstall(): Promise<boolean>
  installNow(): Promise<boolean>
  getStatus(): Promise<UpdateState>
}

/** The persisted facts that gate automatic checks. */
export interface UpdateCheckSettings {
  /** Report the Settings preference for automatic checks. */
  automaticChecks(): boolean
  /** Read the last check time in epoch milliseconds, or null. */
  lastCheckedAt(): number | null
  /** Persist the time of a check that is about to contact the feed. */
  recordCheck(at: number): void
}

interface AutoUpdateControllerOptions extends UpdateCheckSettings {
  capability(): UpdateCapability
  updater(): Updater
  publish(state: UpdateState): void
  now(): number
}

/** Build an isolated state machine around injected transport and publication. */
export function createAutoUpdateController(
  options: AutoUpdateControllerOptions,
): { init(): void; api: AutoUpdateApi } {
  let lastState: UpdateState = {
    phase: 'idle',
    version: null,
    releaseNotes: null,
    percent: null,
    error: null,
    capability: 'noop',
  }

  const pushState = (patch: Partial<UpdateState>): void => {
    lastState = { ...lastState, ...patch, capability: options.capability() }
    options.publish(lastState)
  }

  const reportUpdateFailure = (message: string): void => {
    log.error('Retry the update operation; keep provider detail redacted.')
    pushState({ phase: 'error', error: message, percent: null })
  }

  const subscribe = (): void => {
    options.updater().on('checking-for-update', () => {
      pushState({ phase: 'checking', error: null })
    })
    options.updater().on('update-available', (info) => {
      pushState({
        phase: 'available',
        version: info.version,
        releaseNotes: notesToText(info.releaseNotes),
        percent: null,
        error: null,
      })
    })
    options.updater().on('update-not-available', (info) => {
      pushState({
        phase: 'not-available',
        version: info.version,
        releaseNotes: null,
        percent: null,
        error: null,
      })
    })
    options.updater().on('download-progress', (progress) => {
      pushState({
        phase: 'downloading',
        percent: progress.percent,
        error: null,
      })
    })
    options.updater().on('update-downloaded', (info) => {
      pushState({
        phase: 'downloaded',
        version: info.version,
        releaseNotes: notesToText(info.releaseNotes),
        percent: 100,
        error: null,
      })
    })
    options.updater().on('error', (error) => {
      void error
      reportUpdateFailure(
        'Retry the update operation, or open Releases in your browser.',
      )
    })
  }

  const api: AutoUpdateApi = {
    async check(): Promise<UpdateCheckResult> {
      if (options.capability() === 'noop') return emptyResult()
      // A download in progress or ready to install outranks a new check.
      if (
        lastState.phase === 'downloading' ||
        lastState.phase === 'downloaded'
      ) {
        return {
          available: true,
          version: lastState.version,
          releaseNotes: lastState.releaseNotes,
        }
      }
      try {
        options.recordCheck(options.now())
      } catch {
        // A lost record only allows one extra launch check.
      }
      let result
      try {
        result = await options.updater().checkForUpdates()
      } catch {
        const message =
          'Retry the update check, or open Releases in your browser.'
        reportUpdateFailure(message)
        throw new Error(message)
      }
      if (result == null) return emptyResult()
      return {
        available: result.isUpdateAvailable,
        version: result.updateInfo.version,
        releaseNotes: notesToText(result.updateInfo.releaseNotes),
      }
    },

    async checkOnLaunch(): Promise<boolean> {
      if (
        options.capability() === 'noop' ||
        !options.automaticChecks() ||
        !automaticCheckDue(options.lastCheckedAt(), options.now())
      ) {
        return false
      }
      // The error phase already reports a failed launch check.
      await api.check().catch(() => undefined)
      return true
    },

    async download(): Promise<void> {
      if (options.capability() !== 'full') {
        throw new Error(
          'Download this update from its release page; this build cannot install it.',
        )
      }
      // Download only the version the operator was offered and confirmed.
      if (lastState.phase !== 'available') {
        throw new Error('Check for updates before downloading one.')
      }
      try {
        await options.updater().downloadUpdate()
      } catch {
        const message =
          'Retry the update download, or open Releases in your browser.'
        reportUpdateFailure(message)
        throw new Error(message)
      }
    },

    async canInstall(): Promise<boolean> {
      return options.capability() === 'full' && lastState.phase === 'downloaded'
    },

    async installNow(): Promise<boolean> {
      if (!(await this.canInstall())) return false
      try {
        options.updater().quitAndInstall()
        return true
      } catch (error) {
        void error
        reportUpdateFailure(
          'Retry update installation after the download completes.',
        )
        return false
      }
    },

    async getStatus(): Promise<UpdateState> {
      return { ...lastState, capability: options.capability() }
    },
  }

  return {
    init(): void {
      const target = options.updater()
      target.logger = redactedUpdaterLogger
      // Never download without confirmation, and never step back or onto a
      // prerelease channel.
      target.autoDownload = false
      target.allowPrerelease = false
      target.allowDowngrade = false
      // A downloaded AppImage replaces the running one when the app quits.
      target.autoInstallOnAppQuit = options.capability() === 'full'
      lastState = { ...lastState, capability: options.capability() }
      if (options.capability() !== 'noop') subscribe()
    },
    api,
  }
}

/** Resolves the window that owns published update state, once wired. */
let owningWindow: () => BrowserWindow | null = () => null

/** Reports the persisted check settings, once wired. */
let settings: UpdateCheckSettings = {
  automaticChecks: () => false,
  lastCheckedAt: () => null,
  recordCheck: () => undefined,
}

const controller = createAutoUpdateController({
  capability,
  updater,
  now: () => Date.now(),
  automaticChecks: () => settings.automaticChecks(),
  lastCheckedAt: () => settings.lastCheckedAt(),
  recordCheck: (at) => settings.recordCheck(at),
  publish: (state) => {
    owningWindow()?.webContents.send(IPC_CHANNELS.event, {
      topic: IPC_EVENTS.updateStatus,
      payload: state,
    })
  },
})

/**
 * Initialize the process-wide update controller.
 *
 * @param owner - Resolves the window that owns published update state.
 * @param checkSettings - The automatic-check preference and the persisted time
 *   of the last check.
 */
export function initAutoUpdate(
  owner: () => BrowserWindow | null,
  checkSettings: UpdateCheckSettings,
): void {
  owningWindow = owner
  settings = checkSettings
  controller.init()
}

/** The process-wide capability-gated update API. */
export const autoUpdate = controller.api
