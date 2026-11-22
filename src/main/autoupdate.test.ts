import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import type { BrowserWindow } from 'electron'
import type { UpdateCapability, UpdateCheckSettings } from './autoupdate'

const send = vi.fn()
const otherSend = vi.fn()
const ownerWindow = { webContents: { send } } as unknown as BrowserWindow
const otherWindow = {
  webContents: { send: otherSend },
} as unknown as BrowserWindow
const state = { isPackaged: false, platform: 'linux', appImage: false }
const handlers: Record<string, (arg?: unknown) => void> = {}
const updaterLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return state.isPackaged
    },
  },
  BrowserWindow: { getAllWindows: () => [otherWindow, ownerWindow] },
}))

vi.mock('electron-updater', () => {
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    logger: null,
    on: (event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb
    },
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
  }
  return { default: { autoUpdater }, autoUpdater }
})

vi.mock('electron-log', () => ({ default: updaterLog }))

vi.mock('node:process', () => ({
  default: {
    get platform(): string {
      return state.platform
    },
    get env(): Record<string, string> {
      return state.appImage ? { APPIMAGE: '/tmp/Supraspina.AppImage' } : {}
    },
  },
}))

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 21, 18, 30)

/** Hold the persisted check settings in memory. */
function memorySettings(
  overrides: Partial<{ automatic: boolean; lastCheckedAt: number | null }> = {},
): UpdateCheckSettings & { recorded: number[] } {
  const recorded: number[] = []
  let lastCheckedAt = overrides.lastCheckedAt ?? null
  return {
    recorded,
    automaticChecks: () => overrides.automatic ?? true,
    lastCheckedAt: () => lastCheckedAt,
    recordCheck: (at) => {
      recorded.push(at)
      lastCheckedAt = at
    },
  }
}

async function controllerFor(
  capability: UpdateCapability,
  settings = memorySettings(),
) {
  const mod = await import('./autoupdate')
  const { autoUpdater } = await import('electron-updater')
  const publish = vi.fn()
  const controller = mod.createAutoUpdateController({
    capability: () => capability,
    updater: () => autoUpdater,
    publish,
    now: () => NOW,
    ...settings,
  })
  controller.init()
  return { controller, autoUpdater, publish, settings }
}

function offer(version = '20261122.905.0'): void {
  handlers['update-available']!({ version, releaseNotes: 'Notes' })
}

beforeEach(() => {
  vi.resetModules()
  send.mockClear()
  otherSend.mockClear()
  for (const key of Object.keys(handlers)) delete handlers[key]
  state.isPackaged = false
  state.platform = 'linux'
  state.appImage = false
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('update capability', () => {
  it('resolves every packaging and platform branch', async () => {
    const { resolveCapability } = await import('./autoupdate')
    const cases: Array<[boolean, NodeJS.Platform, boolean, UpdateCapability]> =
      [
        [false, 'linux', true, 'noop'],
        [false, 'linux', false, 'noop'],
        [true, 'linux', true, 'full'],
        [true, 'linux', false, 'notify'],
        [true, 'win32', true, 'noop'],
      ]
    for (const [packaged, platform, appImage, expected] of cases) {
      expect(resolveCapability({ packaged, platform, appImage })).toBe(expected)
    }
  })

  it('stays off the network in development and source runs', async () => {
    state.isPackaged = false
    state.appImage = true
    const mod = await import('./autoupdate')
    const settings = memorySettings()
    mod.initAutoUpdate(() => ownerWindow, settings)

    expect((await mod.autoUpdate.getStatus()).capability).toBe('noop')
    await expect(mod.autoUpdate.checkOnLaunch()).resolves.toBe(false)
    await expect(mod.autoUpdate.check()).resolves.toEqual({
      available: false,
      version: null,
      releaseNotes: null,
    })
    await expect(mod.autoUpdate.download()).rejects.toThrow(/release page/)
    const { autoUpdater } = await import('electron-updater')
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(settings.recorded).toEqual([])
    expect(handlers['update-available']).toBeUndefined()
  })

  it('resolves a packaged AppImage to full and a Debian package to notify', async () => {
    state.isPackaged = true
    state.appImage = true
    let mod = await import('./autoupdate')
    mod.initAutoUpdate(() => ownerWindow, memorySettings())
    expect((await mod.autoUpdate.getStatus()).capability).toBe('full')

    vi.resetModules()
    state.appImage = false
    mod = await import('./autoupdate')
    mod.initAutoUpdate(() => ownerWindow, memorySettings())
    expect((await mod.autoUpdate.getStatus()).capability).toBe('notify')
  })

  it('publishes update state to the injected owning window only', async () => {
    state.isPackaged = true
    const mod = await import('./autoupdate')
    mod.initAutoUpdate(() => ownerWindow, memorySettings())

    handlers['checking-for-update']!()

    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.event,
      expect.objectContaining({ topic: IPC_EVENTS.updateStatus }),
    )
    expect(otherSend).not.toHaveBeenCalled()
  })
})

describe('updater configuration', () => {
  it('never downloads, prereleases, or downgrades on its own', async () => {
    const { autoUpdater } = await controllerFor('full')
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.allowPrerelease).toBe(false)
    expect(autoUpdater.allowDowngrade).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('installs nothing on quit outside an AppImage', async () => {
    const { autoUpdater } = await controllerFor('notify')
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('redacts every provider diagnostic', async () => {
    const { autoUpdater } = await controllerFor('full')
    autoUpdater.logger?.info('/private/info')
    autoUpdater.logger?.warn('/private/warn')
    autoUpdater.logger?.error('/private/error')
    autoUpdater.logger?.debug?.('/private/debug')
    for (const logger of Object.values(updaterLog)) {
      expect(logger).toHaveBeenCalledWith(
        'Review the redacted update diagnostic.',
      )
    }
  })
})

describe('update state machine', () => {
  it('drives every event state', async () => {
    const { controller, publish } = await controllerFor('full')
    expect(Object.keys(handlers).sort()).toEqual([
      'checking-for-update',
      'download-progress',
      'error',
      'update-available',
      'update-downloaded',
      'update-not-available',
    ])
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'idle',
      capability: 'full',
    })

    handlers['checking-for-update']!()
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'checking',
    })
    handlers['update-available']!({
      version: '20261122.905.0',
      releaseNotes: [
        { version: '20261122.905.0', note: 'First note' },
        { version: '20261121.1830.0', note: null },
        { version: '20261120.0.0', note: 'Earlier note' },
      ],
    })
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'available',
      version: '20261122.905.0',
      releaseNotes: 'First note\n\nEarlier note',
    })
    handlers['update-not-available']!({ version: '20261121.1830.0' })
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'not-available',
      version: '20261121.1830.0',
      releaseNotes: null,
    })
    handlers['download-progress']!({ percent: 47.5 })
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'downloading',
      percent: 47.5,
    })
    handlers['update-downloaded']!({
      version: '20261122.905.0',
      releaseNotes: 'Ready to install',
    })
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'downloaded',
      percent: 100,
      releaseNotes: 'Ready to install',
    })
    expect(await controller.api.canInstall()).toBe(true)

    handlers['error']!(new Error('/private/provider/path'))
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'error',
      error: expect.stringMatching(
        /Retry the update operation, or open Releases in your browser/,
      ),
    })
    expect(publish).toHaveBeenCalled()
    expect(updaterLog.error.mock.calls.flat().join(' ')).not.toContain(
      '/private/provider/path',
    )
  })

  it('normalizes manual checks and provider failures', async () => {
    const { controller, autoUpdater, settings } = await controllerFor('full')
    const checkForUpdates = vi.mocked(autoUpdater.checkForUpdates)

    checkForUpdates.mockResolvedValueOnce(null)
    await expect(controller.api.check()).resolves.toEqual({
      available: false,
      version: null,
      releaseNotes: null,
    })
    checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: {
        version: '20261122.905.0',
        releaseNotes: [{ version: '20261122.905.0', note: null }],
      },
    } as never)
    await expect(controller.api.check()).resolves.toEqual({
      available: true,
      version: '20261122.905.0',
      releaseNotes: null,
    })
    checkForUpdates.mockRejectedValueOnce(new Error('/private/provider/path'))
    await expect(controller.api.check()).rejects.toThrow(
      'Retry the update check, or open Releases in your browser.',
    )
    expect(settings.recorded).toEqual([NOW, NOW, NOW])
    expect(updaterLog.error.mock.calls.flat().join(' ')).not.toMatch(
      /\/private\/|provider\/path/,
    )
  })

  it('keeps checking when the check record cannot be written', async () => {
    const settings = memorySettings()
    settings.recordCheck = () => {
      throw new Error('disk full')
    }
    const { controller, autoUpdater } = await controllerFor('full', settings)
    await controller.api.check()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('reports a pending download instead of checking again', async () => {
    const { controller, autoUpdater } = await controllerFor('full')
    offer()
    handlers['download-progress']!({ percent: 10 })
    await expect(controller.api.check()).resolves.toEqual({
      available: true,
      version: '20261122.905.0',
      releaseNotes: 'Notes',
    })
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('lets a Debian package check and offer the release page, never download', async () => {
    const { controller, autoUpdater } = await controllerFor('notify')
    vi.mocked(autoUpdater.checkForUpdates).mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '20261122.905.0', releaseNotes: null },
    } as never)
    await expect(controller.api.check()).resolves.toMatchObject({
      available: true,
    })
    offer()
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'available',
      capability: 'notify',
    })
    await expect(controller.api.download()).rejects.toThrow(
      'Download this update from its release page; this build cannot install it.',
    )
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    await expect(controller.api.installNow()).resolves.toBe(false)
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('the download consent gate', () => {
  it('never downloads during a check, even when an update is available', async () => {
    const { controller, autoUpdater } = await controllerFor('full')
    vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(async () => {
      offer()
      return {
        isUpdateAvailable: true,
        updateInfo: { version: '20261122.905.0', releaseNotes: null },
      } as never
    })
    await controller.api.check()
    await controller.api.checkOnLaunch()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('refuses a download before an offered version', async () => {
    const { controller, autoUpdater } = await controllerFor('full')
    await expect(controller.api.download()).rejects.toThrow(
      'Check for updates before downloading one.',
    )
    handlers['update-not-available']!({ version: '20261121.1830.0' })
    await expect(controller.api.download()).rejects.toThrow(
      'Check for updates before downloading one.',
    )
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('downloads the offered version once the operator confirms it', async () => {
    const { controller, autoUpdater } = await controllerFor('full')
    offer()
    await expect(controller.api.download()).resolves.toBeUndefined()
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce()

    offer()
    vi.mocked(autoUpdater.downloadUpdate).mockRejectedValueOnce(
      new Error('/private/download/path'),
    )
    await expect(controller.api.download()).rejects.toThrow(
      'Retry the update download, or open Releases in your browser.',
    )
  })

  it('installs only a downloaded update and handles synchronous refusal', async () => {
    const { controller, autoUpdater } = await controllerFor('full')
    const quitAndInstall = vi.mocked(autoUpdater.quitAndInstall)

    await expect(controller.api.installNow()).resolves.toBe(false)
    offer()
    await expect(controller.api.installNow()).resolves.toBe(false)
    expect(quitAndInstall).not.toHaveBeenCalled()
    handlers['update-downloaded']!({ version: '20261122.905.0' })
    await expect(controller.api.installNow()).resolves.toBe(true)
    expect(quitAndInstall).toHaveBeenCalledOnce()

    handlers['update-downloaded']!({ version: '20261122.905.0' })
    quitAndInstall.mockImplementationOnce(() => {
      throw new Error('/private/install/path')
    })
    await expect(controller.api.installNow()).resolves.toBe(false)
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'error',
      error: expect.stringMatching(
        /Retry update installation after the download completes/,
      ),
    })
  })
})

describe('the daily launch check', () => {
  it('is due without a record, after a day, and after a clock set back', async () => {
    const { automaticCheckDue, AUTOMATIC_CHECK_INTERVAL_MS } =
      await import('./autoupdate')
    expect(AUTOMATIC_CHECK_INTERVAL_MS).toBe(DAY)
    expect(automaticCheckDue(null, NOW)).toBe(true)
    expect(automaticCheckDue(NOW - DAY, NOW)).toBe(true)
    expect(automaticCheckDue(NOW - DAY + 1, NOW)).toBe(false)
    expect(automaticCheckDue(NOW - 60_000, NOW)).toBe(false)
    expect(automaticCheckDue(NOW + 60_000, NOW)).toBe(true)
  })

  it('checks on the first launch and records the check', async () => {
    const { controller, autoUpdater, settings } = await controllerFor('full')
    await expect(controller.api.checkOnLaunch()).resolves.toBe(true)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
    expect(settings.recorded).toEqual([NOW])
  })

  it('checks at most once a day', async () => {
    const { controller, autoUpdater } = await controllerFor(
      'full',
      memorySettings({ lastCheckedAt: NOW - 2 * 60 * 60 * 1000 }),
    )
    await expect(controller.api.checkOnLaunch()).resolves.toBe(false)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('counts a manual check toward the daily limit', async () => {
    const { controller, autoUpdater } = await controllerFor('notify')
    await controller.api.check()
    await expect(controller.api.checkOnLaunch()).resolves.toBe(false)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('reports a failed launch check through state, not a rejection', async () => {
    const { controller, autoUpdater } = await controllerFor('full')
    vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(
      new Error('offline'),
    )
    await expect(controller.api.checkOnLaunch()).resolves.toBe(true)
    await expect(controller.api.getStatus()).resolves.toMatchObject({
      phase: 'error',
    })
  })

  it('makes no network call while automatic checks are off', async () => {
    const settings = memorySettings({ automatic: false })
    const { controller, autoUpdater } = await controllerFor('full', settings)
    await expect(controller.api.checkOnLaunch()).resolves.toBe(false)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(settings.recorded).toEqual([])

    // An explicit check still runs, because the operator asked for it.
    await controller.api.check()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('wires the persisted settings into the process controller', async () => {
    state.isPackaged = true
    state.appImage = true
    const mod = await import('./autoupdate')
    const settings = memorySettings({ lastCheckedAt: Date.now() })
    mod.initAutoUpdate(() => ownerWindow, settings)
    await expect(mod.autoUpdate.checkOnLaunch()).resolves.toBe(false)

    const off = memorySettings({ automatic: false })
    mod.initAutoUpdate(() => ownerWindow, off)
    await expect(mod.autoUpdate.checkOnLaunch()).resolves.toBe(false)

    const due = memorySettings()
    mod.initAutoUpdate(() => ownerWindow, due)
    await expect(mod.autoUpdate.checkOnLaunch()).resolves.toBe(true)
    expect(due.recorded).toHaveLength(1)
  })
})
