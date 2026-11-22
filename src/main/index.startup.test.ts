import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import { PRODUCTION_RENDERER_CSP } from '../shared/renderer-security'
import type { BoundaryIntent, BoundaryRequest } from '../shared/contract'

const mocks = vi.hoisted(() => ({
  appHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: [] as FakeWindow[],
  resolveReady: (() => undefined) as () => void,
  readyPromise: Promise.resolve(),
  appOn: vi.fn(),
  appQuit: vi.fn(),
  appExit: vi.fn(),
  createWindow: vi.fn(),
  fromPartition: vi.fn(),
  screenOn: vi.fn(),
  screenRemoveListener: vi.fn(),
  screenHandlers: new Map<string, () => void>(),
  nativeThemeOn: vi.fn(),
  nativeThemeRemoveListener: vi.fn(),
  nativeThemeDark: true,
  nativeThemeUpdated: null as null | (() => void),
  sidecar: {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    restartAfterStop: vi.fn(async () => undefined),
  },
  Sidecar: vi.fn(),
  registerIpc: vi.fn(),
  invalidateActiveProject: vi.fn(async () => undefined),
  initAutoUpdate: vi.fn(),
  checkOnLaunch: vi.fn(async () => false),
  canInstall: vi.fn(async () => false),
  installNow: vi.fn(async () => false),
  isPackaged: false,
  smokeEnabled: false,
  smokeObserveWindow: vi.fn(),
  smokeRun: vi.fn(),
  publishSmokeReport: vi.fn(async () => undefined),
  PackageSmokeCoordinator: vi.fn(),
  disposeIpc: vi.fn(),
  userDataPath: '',
  nextWebContentsId: 1,
  ipcOptions: null as null | {
    trustedRenderer: {
      url: string
      webContentsId: number
    }
    lifecycle: {
      request(intent: BoundaryIntent): Promise<void>
      respond(response: {
        requestId: string
        decision: 'proceed' | 'cancel'
      }): Promise<void>
    }
  },
}))

interface FakeSession {
  webRequest: {
    onBeforeRequest: ReturnType<typeof vi.fn>
    onHeadersReceived: ReturnType<typeof vi.fn>
  }
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
}

interface FakeWebContents extends EventEmitter {
  id: number
  send: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  session: FakeSession
}

interface FakeWindow extends EventEmitter {
  options: Record<string, unknown>
  webContents: FakeWebContents
  show: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isMaximized: ReturnType<typeof vi.fn>
  isMinimized: ReturnType<typeof vi.fn>
  getNormalBounds: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  setMinimumSize: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  maximize: ReturnType<typeof vi.fn>
  unmaximize: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  accessibleTitle: string
}

function makeSession(): FakeSession {
  return {
    webRequest: {
      onBeforeRequest: vi.fn(),
      onHeadersReceived: vi.fn(),
    },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  }
}

function makeWindow(options: Record<string, unknown>): FakeWindow {
  const webContents = new EventEmitter() as FakeWebContents
  webContents.id = mocks.nextWebContentsId
  mocks.nextWebContentsId += 1
  webContents.send = vi.fn()
  webContents.reload = vi.fn()
  webContents.setWindowOpenHandler = vi.fn()
  webContents.session = makeSession()
  const window = new EventEmitter() as FakeWindow
  window.options = options
  window.webContents = webContents
  window.show = vi.fn()
  window.close = vi.fn()
  window.loadFile = vi.fn(async () => undefined)
  window.loadURL = vi.fn(async () => undefined)
  window.isDestroyed = vi.fn(() => false)
  window.isMaximized = vi.fn(() => false)
  window.isMinimized = vi.fn(() => false)
  window.getNormalBounds = vi.fn(() => ({
    x: 240,
    y: 90,
    width: 1440,
    height: 900,
  }))
  window.setBounds = vi.fn()
  window.setMinimumSize = vi.fn()
  window.setBackgroundColor = vi.fn()
  window.maximize = vi.fn()
  window.unmaximize = vi.fn()
  window.showInactive = vi.fn()
  window.destroy = vi.fn()
  window.accessibleTitle = ''
  return window
}

vi.mock('electron', () => {
  const BrowserWindow = vi.fn(function BrowserWindowMock(
    this: unknown,
    options: Record<string, unknown>,
  ) {
    return mocks.createWindow(options)
  })
  return {
    app: {
      get isPackaged(): boolean {
        return mocks.isPackaged
      },
      getAppPath: () => '/app',
      getPath: () => mocks.userDataPath,
      whenReady: () => mocks.readyPromise,
      on: mocks.appOn,
      quit: mocks.appQuit,
      exit: mocks.appExit,
    },
    BrowserWindow: Object.assign(BrowserWindow, {
      getAllWindows: () => mocks.windows,
    }),
    nativeTheme: {
      themeSource: 'system',
      get shouldUseDarkColors(): boolean {
        return mocks.nativeThemeDark
      },
      on: mocks.nativeThemeOn,
      removeListener: mocks.nativeThemeRemoveListener,
    },
    screen: {
      getAllDisplays: () => [
        {
          id: 1,
          label: 'Primary',
          internal: true,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          scaleFactor: 1,
          size: { width: 1920, height: 1080 },
        },
      ],
      getPrimaryDisplay: () => ({
        id: 1,
        label: 'Primary',
        internal: true,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        scaleFactor: 1,
        size: { width: 1920, height: 1080 },
      }),
      on: mocks.screenOn,
      removeListener: mocks.screenRemoveListener,
    },
    session: { fromPartition: mocks.fromPartition },
  }
})

vi.mock('./sidecar', () => ({
  Sidecar: mocks.Sidecar,
}))

vi.mock('./ipc', () => ({
  invalidateActiveProject: mocks.invalidateActiveProject,
  registerIpc: mocks.registerIpc,
}))

vi.mock('./autoupdate', () => ({
  autoUpdate: {
    canInstall: mocks.canInstall,
    checkOnLaunch: mocks.checkOnLaunch,
    installNow: mocks.installNow,
  },
  initAutoUpdate: mocks.initAutoUpdate,
}))

vi.mock('./package-smoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./package-smoke')>()
  return {
    ...actual,
    isPackageSmokeMode: vi.fn(() => mocks.smokeEnabled),
    PackageSmokeCoordinator: mocks.PackageSmokeCoordinator,
    publishPackageSmokeReport: mocks.publishSmokeReport,
  }
})

function latestBoundary(window: FakeWindow): BoundaryRequest {
  const envelopes = window.webContents.send.mock.calls
    .map((call) => call[1] as { topic?: string; payload?: unknown })
    .filter((message) => message.topic === IPC_EVENTS.lifecycleBoundary)
  return envelopes.at(-1)!.payload as BoundaryRequest
}

async function settleBoundary(
  window: FakeWindow,
  decision: 'proceed' | 'cancel',
): Promise<void> {
  const request = latestBoundary(window)
  await mocks.ipcOptions!.lifecycle.respond({
    requestId: request.requestId,
    decision,
  })
}

async function loadReadyApp(): Promise<FakeWindow> {
  await import('./index')
  mocks.resolveReady()
  await vi.waitFor(() => expect(mocks.registerIpc).toHaveBeenCalledOnce())
  return mocks.windows[0]!
}

function observeNativeProcessExit() {
  const nativeExit = vi
    .spyOn(
      process as typeof process & {
        reallyExit(code?: number): never
      },
      'reallyExit',
    )
    .mockImplementation(() => {
      throw new Error('Use the native exit fixture.')
    })
  const fallbackExit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('Use the fallback exit fixture.')
  }) as typeof process.exit)
  return { nativeExit, fallbackExit }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.appHandlers.clear()
  mocks.screenHandlers.clear()
  mocks.userDataPath = mkdtempSync(join(tmpdir(), 'supraspina-index-'))
  mocks.nativeThemeDark = true
  mocks.nativeThemeUpdated = null
  mocks.nativeThemeOn.mockImplementation(
    (event: string, handler: () => void) => {
      if (event === 'updated') mocks.nativeThemeUpdated = handler
    },
  )
  mocks.screenOn.mockImplementation((event: string, handler: () => void) => {
    mocks.screenHandlers.set(event, handler)
  })
  mocks.screenRemoveListener.mockImplementation(
    (event: string, handler: () => void) => {
      if (mocks.screenHandlers.get(event) === handler) {
        mocks.screenHandlers.delete(event)
      }
    },
  )
  mocks.windows.splice(0)
  mocks.nextWebContentsId = 1
  mocks.ipcOptions = null
  mocks.disposeIpc = vi.fn()
  mocks.readyPromise = new Promise<void>((resolve) => {
    mocks.resolveReady = resolve
  })
  mocks.appOn.mockImplementation(
    (event: string, handler: (...args: unknown[]) => unknown) => {
      mocks.appHandlers.set(event, handler)
    },
  )
  mocks.createWindow.mockImplementation((options: Record<string, unknown>) => {
    const window = makeWindow(options)
    mocks.windows.push(window)
    return window
  })
  mocks.fromPartition.mockReturnValue(makeSession())
  mocks.Sidecar.mockImplementation(function SidecarMock() {
    return mocks.sidecar
  })
  mocks.registerIpc.mockImplementation((_sidecar, options) => {
    mocks.ipcOptions = options
    return mocks.disposeIpc
  })
  mocks.sidecar.start.mockResolvedValue(undefined)
  mocks.sidecar.stop.mockResolvedValue(undefined)
  mocks.sidecar.restartAfterStop.mockResolvedValue(undefined)
  mocks.invalidateActiveProject.mockResolvedValue(undefined)
  mocks.canInstall.mockResolvedValue(false)
  mocks.installNow.mockResolvedValue(false)
  mocks.isPackaged = false
  mocks.smokeEnabled = false
  mocks.smokeRun.mockResolvedValue({
    schemaVersion: 1,
    ok: true,
    platform: 'linux',
    failureCode: null,
    checks: {},
  })
  mocks.publishSmokeReport.mockResolvedValue(undefined)
  mocks.PackageSmokeCoordinator.mockImplementation(function SmokeMock() {
    return {
      observeWindow: mocks.smokeObserveWindow,
      run: mocks.smokeRun,
    }
  })
  Reflect.set(process, 'resourcesPath', '/bundle/resources')
  Reflect.deleteProperty(process.env, 'ELECTRON_RENDERER_URL')
})

afterEach(() => {
  Reflect.deleteProperty(process.env, 'ELECTRON_RENDERER_URL')
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(process, 'resourcesPath')
  rmSync(mocks.userDataPath, { recursive: true, force: true })
})

describe('main-process startup integration', () => {
  it('starts one sandboxed window, IPC, sidecar, and guarded updater path', async () => {
    const window = await loadReadyApp()

    expect(mocks.Sidecar).toHaveBeenCalledWith('/app', false)
    expect(mocks.registerIpc).toHaveBeenCalledWith(
      mocks.sidecar,
      expect.objectContaining({
        lifecycle: expect.any(Object),
        trustedRenderer: {
          url: expect.stringMatching(/^file:/),
          webContentsId: window.webContents.id,
        },
        thirdPartyNoticesPath: '/app/THIRD_PARTY_NOTICES',
      }),
    )
    expect(mocks.sidecar.start).toHaveBeenCalledOnce()
    expect(mocks.initAutoUpdate).toHaveBeenCalledOnce()
    // The launch check reads the persisted preference and check record.
    const settings = mocks.initAutoUpdate.mock.calls[0]![1] as {
      automaticChecks(): boolean
      lastCheckedAt(): number | null
      recordCheck(at: number): void
    }
    expect(settings.automaticChecks()).toBe(true)
    expect(settings.lastCheckedAt()).toBeNull()
    settings.recordCheck(1_800_000_000_000)
    expect(settings.lastCheckedAt()).toBe(1_800_000_000_000)
    expect(mocks.checkOnLaunch).toHaveBeenCalledOnce()
    const updaterSession = mocks.fromPartition.mock.results[0]!
      .value as FakeSession
    expect(mocks.fromPartition).toHaveBeenCalledWith('electron-updater', {
      cache: false,
    })
    expect(updaterSession.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
    expect(window.options).toMatchObject({
      minWidth: 1100,
      minHeight: 700,
      show: false,
      frame: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })
    expect(window.loadFile).toHaveBeenCalledOnce()
    expect(window.loadURL).not.toHaveBeenCalled()
    const rendererPath = window.loadFile.mock.calls[0]![0] as string
    const trustedRendererUrl = pathToFileURL(rendererPath).href
    expect(mocks.ipcOptions?.trustedRenderer).toEqual({
      url: trustedRendererUrl,
      webContentsId: window.webContents.id,
    })

    window.emit('ready-to-show')
    expect(window.show).toHaveBeenCalledOnce()
    window.emit('maximize')
    window.emit('unmaximize')
    expect(window.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.event,
      expect.objectContaining({ topic: IPC_EVENTS.windowMaximize }),
    )

    const popupPolicy =
      window.webContents.setWindowOpenHandler.mock.calls[0]![0]
    expect(popupPolicy()).toEqual({ action: 'deny' })
    const permissionRequest =
      window.webContents.session.setPermissionRequestHandler.mock.calls[0]![0]
    const deniedPermission = vi.fn()
    permissionRequest(window.webContents, 'camera', deniedPermission, {
      isMainFrame: true,
      requestingUrl: trustedRendererUrl,
    })
    expect(deniedPermission).toHaveBeenCalledWith(false)
    const clipboardWrite = vi.fn()
    permissionRequest(
      window.webContents,
      'clipboard-sanitized-write',
      clipboardWrite,
      { isMainFrame: true, requestingUrl: trustedRendererUrl },
    )
    expect(clipboardWrite).toHaveBeenCalledWith(true)
    const untrustedClipboardWrite = vi.fn()
    permissionRequest(
      window.webContents,
      'clipboard-sanitized-write',
      untrustedClipboardWrite,
      { isMainFrame: true, requestingUrl: 'file:///untrusted/index.html' },
    )
    expect(untrustedClipboardWrite).toHaveBeenCalledWith(false)
    const permissionCheck =
      window.webContents.session.setPermissionCheckHandler.mock.calls[0]![0]
    expect(
      permissionCheck(
        window.webContents,
        'clipboard-sanitized-write',
        'file://',
        { isMainFrame: true, requestingUrl: trustedRendererUrl },
      ),
    ).toBe(true)
    expect(
      permissionCheck(window.webContents, 'clipboard-read', 'file://', {
        isMainFrame: true,
        requestingUrl: trustedRendererUrl,
      }),
    ).toBe(false)
    expect(
      permissionCheck(
        { id: window.webContents.id },
        'clipboard-sanitized-write',
        'file://',
        { isMainFrame: true, requestingUrl: trustedRendererUrl },
      ),
    ).toBe(false)
    expect(
      permissionCheck(
        window.webContents,
        'clipboard-sanitized-write',
        'file://',
        { isMainFrame: false, requestingUrl: trustedRendererUrl },
      ),
    ).toBe(false)

    const headersReceived =
      window.webContents.session.webRequest.onHeadersReceived.mock.calls[0]![0]
    const secured = vi.fn()
    headersReceived(
      {
        url: trustedRendererUrl,
        resourceType: 'mainFrame',
        webContentsId: window.webContents.id,
        responseHeaders: {
          'content-security-policy': ["default-src 'unsafe-inline'"],
          'X-Content-Type-Options': ['nosniff'],
        },
      },
      secured,
    )
    expect(secured).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': [PRODUCTION_RENDERER_CSP],
        'X-Content-Type-Options': ['nosniff'],
      },
    })

    const untouched = vi.fn()
    const scriptHeaders = { 'Cache-Control': ['no-cache'] }
    headersReceived(
      {
        url: `${trustedRendererUrl}.js`,
        resourceType: 'script',
        webContentsId: window.webContents.id,
        responseHeaders: scriptHeaders,
      },
      untouched,
    )
    expect(untouched).toHaveBeenCalledWith({
      responseHeaders: scriptHeaders,
    })

    const wrongWindow = vi.fn()
    headersReceived(
      {
        url: trustedRendererUrl,
        resourceType: 'mainFrame',
        webContentsId: window.webContents.id + 1,
        responseHeaders: scriptHeaders,
      },
      wrongWindow,
    )
    expect(wrongWindow).toHaveBeenCalledWith({
      responseHeaders: scriptHeaders,
    })
  })

  it('keeps the native window background synchronized with System theme', async () => {
    mocks.nativeThemeDark = false
    const window = await loadReadyApp()
    expect(window.options.backgroundColor).toBe('#fafbfc')

    mocks.nativeThemeDark = true
    mocks.nativeThemeUpdated?.()
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#0e0f12')

    mocks.nativeThemeDark = false
    mocks.nativeThemeUpdated?.()
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#fafbfc')
  })

  it('persists geometry and reconciles every live display-topology event', async () => {
    const window = await loadReadyApp()
    const placement = (
      mocks.ipcOptions as unknown as {
        windowPlacement: {
          getState(): { displays: unknown[] }
          setPreference(preference: { mode: 'primary' }): unknown
          moveNow(): unknown
          identifyDisplays(): void
        }
      }
    ).windowPlacement

    expect(placement.getState().displays).toHaveLength(1)
    for (const event of [
      'display-added',
      'display-removed',
      'display-metrics-changed',
    ]) {
      mocks.screenHandlers.get(event)?.()
    }

    placement.setPreference({ mode: 'primary' })
    window.getNormalBounds.mockReturnValue({
      x: 5_000,
      y: 5_000,
      width: 1_440,
      height: 900,
    })
    placement.moveNow()
    expect(window.setBounds).toHaveBeenCalled()

    vi.useFakeTimers()
    window.emit('move')
    window.emit('resize')
    vi.advanceTimersByTime(400)
    const saved = JSON.parse(
      readFileSync(
        join(mocks.userDataPath, 'machine-preferences.json'),
        'utf8',
      ),
    ) as { window?: { width?: number; height?: number } }
    expect(saved.window).toMatchObject({ width: 1440, height: 900 })

    window.isMaximized.mockReturnValue(true)
    window.emit('move')
    vi.advanceTimersByTime(400)
    window.isMaximized.mockReturnValue(false)
    window.isDestroyed.mockReturnValue(true)
    window.emit('move')
    vi.advanceTimersByTime(400)
    window.isDestroyed.mockReturnValue(false)

    placement.identifyDisplays()
    expect(mocks.createWindow).toHaveBeenCalledTimes(2)
    const overlay = mocks.windows[1]!
    overlay.emit('ready-to-show')
    expect(overlay.showInactive).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(3_000)
    expect(overlay.destroy).toHaveBeenCalledOnce()

    window.emit('move')
    window.emit('closed')
    expect(mocks.screenHandlers).toEqual(new Map())
  })

  it('uses frameless chrome and quits after the last window', async () => {
    const window = await loadReadyApp()
    expect(window.options).toMatchObject({ frame: false })
    expect(window.options).not.toHaveProperty('titleBarStyle')
    expect(window.options).not.toHaveProperty('trafficLightPosition')

    const closing = mocks.ipcOptions!.lifecycle.request('window-close')
    await settleBoundary(window, 'proceed')
    await closing
    expect(mocks.sidecar.stop).toHaveBeenCalledOnce()
    expect(window.close).toHaveBeenCalledOnce()

    mocks.appHandlers.get('window-all-closed')!()
    expect(mocks.appQuit).toHaveBeenCalledOnce()
  })

  it('enforces navigation, reload, popup, and native-unload boundaries', async () => {
    const window = await loadReadyApp()
    const rendererPath = window.loadFile.mock.calls[0]![0] as string
    const bootUrl = pathToFileURL(rendererPath).href
    const allowed = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', allowed, bootUrl)
    expect(allowed.preventDefault).not.toHaveBeenCalled()

    const external = { preventDefault: vi.fn() }
    window.webContents.emit(
      'will-navigate',
      external,
      'https://example.test/untrusted',
    )
    expect(external.preventDefault).toHaveBeenCalledOnce()

    const redirects = [{ preventDefault: vi.fn() }, { preventDefault: vi.fn() }]
    window.webContents.emit('will-redirect', redirects[0])
    window.webContents.emit('will-attach-webview', redirects[1])
    expect(
      redirects.every((event) => event.preventDefault.mock.calls.length === 1),
    ).toBe(true)

    const ordinaryInput = { preventDefault: vi.fn() }
    window.webContents.emit('before-input-event', ordinaryInput, {
      type: 'keyDown',
      key: 'K',
      control: true,
      meta: false,
    })
    expect(ordinaryInput.preventDefault).not.toHaveBeenCalled()

    for (const input of [
      { type: 'keyDown', key: 'F5', control: false, meta: false },
      { type: 'keyDown', key: 'r', control: true, meta: false },
      { type: 'keyDown', key: 'R', control: false, meta: true },
    ]) {
      const event = { preventDefault: vi.fn() }
      window.webContents.emit('before-input-event', event, input)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      await settleBoundary(window, 'cancel')
    }

    const reload = mocks.ipcOptions!.lifecycle.request('renderer-reload')
    await settleBoundary(window, 'proceed')
    await reload
    expect(mocks.invalidateActiveProject).toHaveBeenCalledWith(mocks.sidecar)
    expect(window.webContents.reload).toHaveBeenCalledOnce()

    const approvedNavigation = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', approvedNavigation, bootUrl)
    expect(approvedNavigation.preventDefault).not.toHaveBeenCalled()

    const unload = { preventDefault: vi.fn() }
    window.webContents.emit('will-prevent-unload', unload)
    expect(unload.preventDefault).toHaveBeenCalledOnce()
    const repeated = { preventDefault: vi.fn() }
    window.webContents.emit('will-prevent-unload', repeated)
    expect(repeated.preventDefault).not.toHaveBeenCalled()
    window.webContents.emit('did-finish-load')

    const finishingReload =
      mocks.ipcOptions!.lifecycle.request('renderer-reload')
    await settleBoundary(window, 'proceed')
    await finishingReload
    window.webContents.emit('did-finish-load')

    const repeatedBoot = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', repeatedBoot, bootUrl)
    expect(repeatedBoot.preventDefault).toHaveBeenCalledOnce()
    await settleBoundary(window, 'cancel')
  })

  it('serializes window close, app quit, activation, and final disposal', async () => {
    const window = await loadReadyApp()
    const initialQuitEvent = { preventDefault: vi.fn() }
    mocks.appHandlers.get('before-quit')!(initialQuitEvent)
    expect(initialQuitEvent.preventDefault).toHaveBeenCalledOnce()
    await settleBoundary(window, 'cancel')

    const closeEvent = { preventDefault: vi.fn() }
    window.emit('close', closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    await settleBoundary(window, 'cancel')

    const closing = mocks.ipcOptions!.lifecycle.request('window-close')
    await settleBoundary(window, 'proceed')
    await closing
    expect(mocks.sidecar.stop).toHaveBeenCalledOnce()
    expect(window.close).toHaveBeenCalledOnce()
    const approvedClose = { preventDefault: vi.fn() }
    window.emit('close', approvedClose)
    expect(approvedClose.preventDefault).not.toHaveBeenCalled()

    window.emit('closed')
    mocks.windows.splice(0)
    await mocks.appHandlers.get('activate')!()
    expect(mocks.createWindow).toHaveBeenCalledTimes(2)
    window.emit('closed')

    mocks.appHandlers.get('window-all-closed')!()
    expect(mocks.appQuit).toHaveBeenCalledOnce()
    const quitEvent = { preventDefault: vi.fn() }
    mocks.appHandlers.get('before-quit')!(quitEvent)
    expect(quitEvent.preventDefault).not.toHaveBeenCalled()

    mocks.appHandlers.get('will-quit')!()
    // Rebind IPC to the new placement controller when recreating the window.
    // Dispose the old binding during rebinding and the new binding during final
    // quit.
    expect(mocks.disposeIpc).toHaveBeenCalledTimes(2)
    expect(mocks.sidecar.stop).toHaveBeenCalledTimes(2)
  })

  it('does not access the destroyed window during closed cleanup', async () => {
    const window = await loadReadyApp()
    Object.defineProperty(window, 'webContents', {
      configurable: true,
      get: () => {
        throw new TypeError('Object has been destroyed')
      },
    })

    expect(() => window.emit('closed')).not.toThrow()
  })

  it('loads the exact loopback development renderer without weakening security flags', async () => {
    Reflect.set(process.env, 'ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173/')
    const window = await loadReadyApp()

    expect(window.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/')
    expect(window.loadFile).not.toHaveBeenCalled()
    expect(window.options).toMatchObject({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    expect(mocks.ipcOptions?.trustedRenderer).toEqual({
      url: 'http://127.0.0.1:5173/',
      webContentsId: window.webContents.id,
    })

    const headersReceived =
      window.webContents.session.webRequest.onHeadersReceived.mock.calls[0]![0]
    const callback = vi.fn()
    headersReceived(
      {
        url: 'http://127.0.0.1:5173/',
        resourceType: 'mainFrame',
        webContentsId: window.webContents.id,
      },
      callback,
    )
    expect(
      callback.mock.calls[0]![0].responseHeaders['Content-Security-Policy'][0],
    ).toContain("connect-src 'self' ws://127.0.0.1:5173")
  })

  it('ignores a poisoned renderer override in packaged mode and boots only the ASAR file', async () => {
    const attacker = 'https://127.0.0.1:9/attacker'
    mocks.isPackaged = true
    Reflect.set(process.env, 'ELECTRON_RENDERER_URL', attacker)

    const window = await loadReadyApp()
    const loadedPath = window.loadFile.mock.calls[0]![0] as string

    expect(window.loadFile).toHaveBeenCalledOnce()
    expect(window.loadURL).not.toHaveBeenCalled()
    expect(window.loadURL.mock.calls.some((call) => call[0] === attacker)).toBe(
      false,
    )
    expect(loadedPath).toMatch(/renderer[/\\]index\.html$/)
    expect(mocks.ipcOptions?.trustedRenderer).toEqual({
      url: pathToFileURL(loadedPath).href,
      webContentsId: window.webContents.id,
    })
  })

  it('does not create a duplicate window when activation finds an existing one', async () => {
    await loadReadyApp()

    await mocks.appHandlers.get('activate')!()

    expect(mocks.createWindow).toHaveBeenCalledOnce()
  })

  it('crosses the update-install boundary only after readiness is rechecked', async () => {
    mocks.canInstall.mockResolvedValue(true)
    mocks.installNow.mockResolvedValue(true)
    const window = await loadReadyApp()

    const installing = mocks.ipcOptions!.lifecycle.request('update-install')
    await settleBoundary(window, 'proceed')
    await installing

    expect(mocks.canInstall).toHaveBeenCalledTimes(2)
    expect(mocks.sidecar.stop).toHaveBeenCalledOnce()
    expect(mocks.installNow).toHaveBeenCalledOnce()
    expect(mocks.sidecar.restartAfterStop).not.toHaveBeenCalled()
  })

  it('runs the opt-in packaged smoke coordinator instead of a parallel sidecar start', async () => {
    const priorExitCode = process.exitCode
    vi.useFakeTimers()
    mocks.isPackaged = true
    mocks.smokeEnabled = true
    const window = await loadReadyApp()
    await vi.waitFor(() =>
      expect(mocks.publishSmokeReport).toHaveBeenCalledOnce(),
    )

    expect(mocks.PackageSmokeCoordinator).toHaveBeenCalledOnce()
    expect(mocks.smokeObserveWindow).toHaveBeenCalledWith(
      window,
      expect.any(Object),
    )
    expect(mocks.fromPartition).toHaveBeenCalledWith('electron-updater', {
      cache: false,
    })
    expect(mocks.sidecar.start).not.toHaveBeenCalled()
    // The smoke keeps its own block-all filter and never checks for updates.
    expect(mocks.checkOnLaunch).not.toHaveBeenCalled()
    const updaterSession = mocks.fromPartition.mock.results[0]!
      .value as FakeSession
    expect(updaterSession.webRequest.onBeforeRequest).not.toHaveBeenCalled()
    expect(mocks.smokeRun).toHaveBeenCalledWith({
      paths: expect.objectContaining({
        appPath: '/app',
        resourcesPath: '/bundle/resources',
      }),
      sidecar: mocks.sidecar,
    })
    expect(process.exitCode).toBe(0)
    expect(mocks.appQuit).toHaveBeenCalledOnce()
    expect(mocks.appExit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.appExit).toHaveBeenCalledWith(1)
    const { nativeExit, fallbackExit } = observeNativeProcessExit()
    expect(() => mocks.appHandlers.get('quit')!({}, 1)).toThrow(
      /Use the fallback exit fixture/,
    )
    expect(nativeExit).toHaveBeenCalledWith(1)
    expect(fallbackExit).toHaveBeenCalledWith(1)
    process.exitCode = priorExitCode
  })

  it('arms the packaged-smoke exit bound before report publication settles', async () => {
    const priorExitCode = process.exitCode
    vi.useFakeTimers()
    mocks.isPackaged = true
    mocks.smokeEnabled = true
    mocks.publishSmokeReport.mockReturnValueOnce(new Promise(() => undefined))

    await loadReadyApp()
    await Promise.resolve()
    expect(mocks.publishSmokeReport).toHaveBeenCalledOnce()
    expect(mocks.appExit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.appExit).toHaveBeenCalledWith(1)
    expect(mocks.appQuit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    const { nativeExit, fallbackExit } = observeNativeProcessExit()
    expect(() => mocks.appHandlers.get('will-quit')!()).toThrow(
      /Use the fallback exit fixture/,
    )
    expect(nativeExit).toHaveBeenCalledWith(1)
    expect(fallbackExit).toHaveBeenCalledWith(1)
    process.exitCode = priorExitCode
  })

  it('publishes a failing packaged-smoke report and uses the bounded exit fallback', async () => {
    const priorExitCode = process.exitCode
    mocks.isPackaged = true
    mocks.smokeEnabled = true
    mocks.smokeRun.mockResolvedValue({
      schemaVersion: 1,
      ok: false,
      platform: 'linux',
      failureCode: 'SIDECAR_HANDSHAKE_FAILED',
      checks: {},
    })
    mocks.appQuit.mockImplementationOnce(() => {
      throw new Error('Review the refused quit request.')
    })

    await loadReadyApp()
    await vi.waitFor(() => expect(mocks.appExit).toHaveBeenCalledWith(1))

    expect(mocks.publishSmokeReport).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    )
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('uses a nonzero fallback when a successful smoke report cannot trigger app quit', async () => {
    const priorExitCode = process.exitCode
    mocks.isPackaged = true
    mocks.smokeEnabled = true
    mocks.appQuit.mockImplementationOnce(() => {
      throw new Error('Review the refused quit request.')
    })

    await loadReadyApp()
    await vi.waitFor(() => expect(mocks.appExit).toHaveBeenCalledWith(1))

    expect(mocks.publishSmokeReport).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
    )
    expect(process.exitCode).toBe(1)
    const { nativeExit, fallbackExit } = observeNativeProcessExit()
    expect(() => mocks.appHandlers.get('quit')!({}, 1)).toThrow(
      /Use the fallback exit fixture/,
    )
    expect(nativeExit).toHaveBeenCalledWith(1)
    expect(fallbackExit).toHaveBeenCalledWith(1)
    process.exitCode = priorExitCode
  })

  it('uses native process exit only after smoke-mode will-quit teardown', async () => {
    const priorExitCode = process.exitCode
    vi.useFakeTimers()
    mocks.isPackaged = true
    mocks.smokeEnabled = true
    await loadReadyApp()
    await vi.waitFor(() =>
      expect(mocks.publishSmokeReport).toHaveBeenCalledOnce(),
    )
    const { nativeExit, fallbackExit } = observeNativeProcessExit()

    expect(() => mocks.appHandlers.get('will-quit')!()).toThrow(
      /Use the fallback exit fixture/,
    )
    expect(mocks.disposeIpc).toHaveBeenCalledOnce()
    expect(nativeExit).toHaveBeenCalledWith(0)
    expect(fallbackExit).toHaveBeenCalledWith(1)
    process.exitCode = priorExitCode
  })

  it('preserves a failing smoke outcome when Electron reports quit code zero', async () => {
    vi.useFakeTimers()
    mocks.isPackaged = true
    mocks.smokeEnabled = true
    mocks.smokeRun.mockResolvedValue({
      schemaVersion: 1,
      ok: false,
      platform: 'linux',
      failureCode: 'runtime-contract',
      checks: {},
    })
    await loadReadyApp()
    await vi.waitFor(() =>
      expect(mocks.publishSmokeReport).toHaveBeenCalledOnce(),
    )
    const { nativeExit, fallbackExit } = observeNativeProcessExit()

    expect(() => mocks.appHandlers.get('will-quit')!()).toThrow(
      /Use the fallback exit fixture/,
    )
    expect(nativeExit).toHaveBeenCalledWith(1)
    expect(fallbackExit).toHaveBeenCalledWith(1)
  })

  it('defaults a pre-report smoke quit to failure', async () => {
    mocks.isPackaged = true
    mocks.smokeEnabled = true
    const { nativeExit, fallbackExit } = observeNativeProcessExit()
    await import('./index')

    expect(() => mocks.appHandlers.get('quit')!({}, 0)).toThrow(
      /Use the fallback exit fixture/,
    )
    expect(nativeExit).toHaveBeenCalledWith(1)
    expect(fallbackExit).toHaveBeenCalledWith(1)
  })

  it('never uses native process exit for an ordinary app quit', async () => {
    const nativeExit = vi.spyOn(
      process as typeof process & {
        reallyExit(code?: number): never
      },
      'reallyExit',
    )
    const fallbackExit = vi.spyOn(process, 'exit')
    await loadReadyApp()

    mocks.appHandlers.get('will-quit')!()
    expect(() => mocks.appHandlers.get('quit')!({}, 0)).not.toThrow()
    expect(nativeExit).not.toHaveBeenCalled()
    expect(fallbackExit).not.toHaveBeenCalled()
  })

  it('revokes update quit approval and restores the sidecar when install refuses', async () => {
    mocks.canInstall.mockResolvedValue(true)
    mocks.installNow.mockResolvedValue(false)
    const window = await loadReadyApp()

    const installing = mocks.ipcOptions!.lifecycle.request('update-install')
    await expect(settleBoundary(window, 'proceed')).rejects.toThrow(
      /Download the update again before installing it/,
    )
    await expect(installing).rejects.toThrow(
      /Download the update again before installing it/,
    )
    expect(mocks.sidecar.restartAfterStop).toHaveBeenCalledOnce()

    const unload = { preventDefault: vi.fn() }
    window.webContents.emit('will-prevent-unload', unload)
    expect(unload.preventDefault).not.toHaveBeenCalled()
    const quit = { preventDefault: vi.fn() }
    mocks.appHandlers.get('before-quit')!(quit)
    expect(quit.preventDefault).toHaveBeenCalledOnce()
    await settleBoundary(window, 'cancel')
  })

  it('fails closed and revokes native approvals when Electron boundaries throw', async () => {
    const window = await loadReadyApp()
    window.webContents.reload.mockImplementationOnce(() => {
      throw new Error('Review the refused reload request.')
    })
    const reload = mocks.ipcOptions!.lifecycle.request('renderer-reload')
    await expect(settleBoundary(window, 'proceed')).rejects.toThrow(
      /refused reload/,
    )
    await expect(reload).rejects.toThrow(/refused reload/)

    window.close.mockImplementationOnce(() => {
      throw new Error('Review the refused close request.')
    })
    const closing = mocks.ipcOptions!.lifecycle.request('window-close')
    await expect(settleBoundary(window, 'proceed')).rejects.toThrow(
      /refused close/,
    )
    await expect(closing).rejects.toThrow(/refused close/)

    mocks.appQuit.mockImplementationOnce(() => {
      throw new Error('Review the refused quit request.')
    })
    const quitting = mocks.ipcOptions!.lifecycle.request('app-quit')
    await expect(settleBoundary(window, 'proceed')).rejects.toThrow(
      /refused quit/,
    )
    await expect(quitting).rejects.toThrow(/refused quit/)

    const unload = { preventDefault: vi.fn() }
    window.webContents.emit('will-prevent-unload', unload)
    expect(unload.preventDefault).not.toHaveBeenCalled()
  })

  it('treats a destroyed window close as already complete', async () => {
    const window = await loadReadyApp()

    const closing = mocks.ipcOptions!.lifecycle.request('window-close')
    window.isDestroyed.mockReturnValue(true)
    await settleBoundary(window, 'proceed')
    await expect(closing).resolves.toBeUndefined()
    expect(window.close).not.toHaveBeenCalled()
    expect(mocks.sidecar.stop).not.toHaveBeenCalled()
  })

  it('fails a lifecycle request when its renderer boundary is unavailable', async () => {
    const window = await loadReadyApp()
    window.isDestroyed.mockReturnValue(true)

    await expect(
      mocks.ipcOptions!.lifecycle.request('renderer-reload'),
    ).rejects.toThrow(/Present the boundary confirmation in the renderer/)
  })

  it('fails a renderer reload if the window is destroyed after confirmation is shown', async () => {
    const window = await loadReadyApp()
    const reload = mocks.ipcOptions!.lifecycle.request('renderer-reload')
    window.isDestroyed.mockReturnValue(true)

    await expect(settleBoundary(window, 'proceed')).rejects.toThrow(
      /Open an application window before reloading it/,
    )
    await expect(reload).rejects.toThrow(
      /Open an application window before reloading it/,
    )
  })

  it('does not retain reload approval if the window closes while reload throws', async () => {
    const window = await loadReadyApp()
    window.webContents.reload.mockImplementationOnce(() => {
      window.emit('closed')
      throw new Error('Retry after the window closes during reload.')
    })
    const reload = mocks.ipcOptions!.lifecycle.request('renderer-reload')

    await expect(settleBoundary(window, 'proceed')).rejects.toThrow(
      /closes during reload/,
    )
    await expect(reload).rejects.toThrow(/closes during reload/)
  })

  it('does not approve a destroyed window when an update install is refused', async () => {
    mocks.canInstall.mockResolvedValue(true)
    mocks.installNow.mockResolvedValue(false)
    const window = await loadReadyApp()
    const installing = mocks.ipcOptions!.lifecycle.request('update-install')
    window.isDestroyed.mockReturnValue(true)

    await expect(settleBoundary(window, 'proceed')).rejects.toThrow(
      /Download the update again before installing it/,
    )
    await expect(installing).rejects.toThrow(
      /Download the update again before installing it/,
    )

    const unload = { preventDefault: vi.fn() }
    window.webContents.emit('will-prevent-unload', unload)
    expect(unload.preventDefault).not.toHaveBeenCalled()
  })

  it('revokes an app quit safely when the originating window closes and Electron refuses', async () => {
    const window = await loadReadyApp()
    const quitting = mocks.ipcOptions!.lifecycle.request('app-quit')
    window.emit('closed')
    mocks.appQuit.mockImplementationOnce(() => {
      throw new Error('Review the refused quit request.')
    })

    await expect(settleBoundary(window, 'proceed')).rejects.toThrow(
      /refused quit/,
    )
    await expect(quitting).rejects.toThrow(/refused quit/)

    expect(mocks.appQuit).toHaveBeenCalledOnce()
  })

  it('leaves quit and disposal events inert before startup has a coordinator', async () => {
    await import('./index')
    const quitEvent = { preventDefault: vi.fn() }

    mocks.appHandlers.get('before-quit')!(quitEvent)
    mocks.appHandlers.get('will-quit')!()

    expect(quitEvent.preventDefault).not.toHaveBeenCalled()
    expect(mocks.disposeIpc).not.toHaveBeenCalled()
    expect(mocks.sidecar.stop).not.toHaveBeenCalled()
  })
})
