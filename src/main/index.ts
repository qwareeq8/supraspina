/**
 * Starts the Electron main process.
 *
 * Creates the single application window, registers IPC dispatch, and supervises
 * the Python orchestration sidecar. `contextIsolation` is enabled and
 * `nodeIntegration` is disabled, so the renderer reaches the backend only
 * through the `window.supraspina` contextBridge. The preload is bundled as
 * standalone CommonJS so the renderer remains sandboxed.
 */

import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { app, BrowserWindow, nativeTheme, screen, session } from 'electron'
import { Sidecar } from './sidecar'
import {
  invalidateActiveProject,
  registerIpc,
  type TrustedRendererIdentity,
} from './ipc'
import { autoUpdate, initAutoUpdate } from './autoupdate'
import { UPDATER_PARTITION, guardUpdateNetwork } from './update-network'
import { IPC_CHANNELS, IPC_EVENTS } from '../shared/ipc'
import { BoundaryCoordinator } from './lifecycle'
import type { BoundaryIntent, BoundaryRequest } from '../shared/contract'
import {
  PackageSmokeCoordinator,
  isPackageSmokeMode,
  publishPackageSmokeReport,
  type PackageSmokeReport,
} from './package-smoke'
import {
  MachinePreferenceController,
  PreferenceStore,
  type SavedWindowBounds,
} from './preferences'
import {
  WindowPlacementController,
  captureDisplayTopology,
  resolveStartupWindowPlacement,
  type DisplayTopologySource,
} from './window-placement'
import {
  PRODUCTION_RENDERER_CSP,
  developmentRendererCsp,
  normalizeDevelopmentRendererUrl,
  withRendererCsp,
} from '../shared/renderer-security'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const rendererPath = join(moduleDir, '../renderer/index.html')
const preloadPath = join(moduleDir, '../preload/index.cjs')

/** The trusted renderer target selected for startup. */
export interface RendererTarget {
  kind: 'file' | 'development'
  url: string
  contentSecurityPolicy: string
}

interface RendererPermissionEvidence {
  permission: string
  requestingUrl: string | undefined
  isMainFrame: boolean
  matchesWindow: boolean
  trustedUrl: string
}

/**
 * Grant only sanitized clipboard writes from the exact trusted main frame.
 * Deny clipboard reads and every device, media, location, notification, storage,
 * popup, and filesystem permission.
 */
export function allowRendererPermission(
  evidence: RendererPermissionEvidence,
): boolean {
  const { permission, requestingUrl, isMainFrame, matchesWindow, trustedUrl } =
    evidence
  return (
    permission === 'clipboard-sanitized-write' &&
    matchesWindow &&
    isMainFrame &&
    requestingUrl === trustedUrl
  )
}

/**
 * Resolve the one renderer origin the window and privileged IPC may trust.
 * Never consult the developer override from a packaged application.
 *
 * @param filePath - The absolute packaged renderer path.
 * @throws When the packaged path or development URL is invalid.
 */
export function resolveRendererTarget(
  packaged: boolean,
  override: string | undefined,
  filePath: string,
): RendererTarget {
  if (!isAbsolute(filePath)) {
    throw new Error('Provide an absolute packaged renderer path.')
  }
  const fileUrl = pathToFileURL(filePath).href
  if (packaged || override === undefined) {
    return {
      kind: 'file',
      url: fileUrl,
      contentSecurityPolicy: PRODUCTION_RENDERER_CSP,
    }
  }
  const url = normalizeDevelopmentRendererUrl(override)
  return {
    kind: 'development',
    url,
    contentSecurityPolicy: developmentRendererCsp(url),
  }
}

/** Resolve the exact packaged smoke gate used by the startup integration. */
export function shouldRunPackageSmoke(
  packaged: boolean,
  argv: readonly string[],
): boolean {
  return isPackageSmokeMode(packaged, argv)
}

const packageSmokeEnabled = shouldRunPackageSmoke(app.isPackaged, process.argv)
const packageSmokeCoordinator = packageSmokeEnabled
  ? new PackageSmokeCoordinator({
      enabled: true,
      argv: process.argv,
      platform: process.platform,
      env: process.env,
    })
  : null
let packageSmokeExitCode: number | null = packageSmokeEnabled ? 1 : null

let sidecar: Sidecar | null = null
let mainWindow: BrowserWindow | null = null
let boundaryCoordinator: BoundaryCoordinator | null = null
let disposeIpc: (() => void) | null = null
let preferenceStore: PreferenceStore | null = null
let machinePreferences: MachinePreferenceController | null = null
let windowPlacement: WindowPlacementController | null = null
let disposeGeometry: (() => void) | null = null
let disposeWindowTheme: (() => void) | null = null
let approvedWindowClose: BrowserWindow | null = null
let approvedReload: BrowserWindow | null = null
let approvedAppQuit = false
let expectedRenderer: TrustedRendererIdentity | null = null

const NATIVE_UNLOAD_APPROVAL_TTL_MS = 10_000

interface PendingNativeUnloadApproval {
  window: object
  intent: BoundaryIntent
  token: symbol
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

interface PreventableEvent {
  preventDefault(): void
}

/**
 * One-shot authority to override a renderer beforeunload veto after a boundary
 * completes its fallible teardown. Interpret Electron's inverted
 * `will-prevent-unload` event correctly: `preventDefault()` permits the unload.
 */
export class NativeUnloadApprovalGate {
  private pending: PendingNativeUnloadApproval | null = null

  constructor(private readonly ttlMs = NATIVE_UNLOAD_APPROVAL_TTL_MS) {}

  approve(window: object, intent: BoundaryIntent): symbol {
    this.clear()
    const token = Symbol(intent)
    const timer = setTimeout(() => this.revoke(token), this.ttlMs)
    timer.unref()
    this.pending = {
      window,
      intent,
      token,
      expiresAt: Date.now() + this.ttlMs,
      timer,
    }
    return token
  }

  /** Permit exactly one renderer veto for the approved window and boundary. */
  permit(window: object, event: PreventableEvent): BoundaryIntent | null {
    const pending = this.pending
    if (!pending || pending.window !== window) return null
    if (Date.now() >= pending.expiresAt) {
      this.clear()
      return null
    }
    const { intent } = pending
    this.clear()
    event.preventDefault()
    return intent
  }

  revoke(token: symbol): void {
    if (this.pending?.token === token) this.clear()
  }

  clearWindow(window: object): void {
    if (this.pending?.window === window) this.clear()
  }

  clear(): void {
    const pending = this.pending
    this.pending = null
    if (pending) clearTimeout(pending.timer)
  }
}

const nativeUnloadApprovals = new NativeUnloadApprovalGate()

/**
 * Finish the test-only packaged launch after Electron's quit teardown.
 *
 * Account for Electron replacing `process.exit()` in its main process with an
 * app-level exit that can leave the embedded Node loop alive after `will-quit`.
 * Use the native Node exit primitive only after the `will-quit` handler completes, or
 * from `quit` when the five-second `app.exit()` failure fallback bypasses
 * `will-quit`, and only for the explicit packaged-smoke mode.
 *
 * @throws When no native exit path terminates the process.
 */
export function finishPackageSmokeProcessExit(
  enabled: boolean,
  exitCode: number,
  runtime: object = process,
): void {
  if (!enabled) return
  const code =
    Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255
      ? exitCode
      : 1
  const reallyExit = Reflect.get(runtime, 'reallyExit')
  if (typeof reallyExit === 'function') {
    try {
      Reflect.apply(reallyExit, runtime, [code])
    } catch {
      // Fall through to a deliberately failing conventional exit.
    }
  }
  const fallbackExit = Reflect.get(runtime, 'exit')
  if (typeof fallbackExit === 'function') {
    Reflect.apply(fallbackExit, runtime, [code || 1])
  }
  throw new Error('Keep the native package-smoke process exit from returning.')
}

function displayTopologySource(): DisplayTopologySource {
  return {
    snapshot: () => ({
      displays: screen.getAllDisplays(),
      primaryDisplay: screen.getPrimaryDisplay(),
    }),
    subscribe: (handler) => {
      const added = (): void => handler()
      const removed = (): void => handler()
      const metricsChanged = (): void => handler()
      screen.on('display-added', added)
      screen.on('display-removed', removed)
      screen.on('display-metrics-changed', metricsChanged)
      return () => {
        screen.removeListener('display-added', added)
        screen.removeListener('display-removed', removed)
        screen.removeListener('display-metrics-changed', metricsChanged)
      }
    },
  }
}

function attachGeometryPersistence(
  win: BrowserWindow,
  preferences: PreferenceStore,
): () => void {
  let normalBounds = win.getNormalBounds()
  let timer: ReturnType<typeof setTimeout> | null = null
  const snapshot = (): SavedWindowBounds => ({
    x: normalBounds.x,
    y: normalBounds.y,
    width: normalBounds.width,
    height: normalBounds.height,
    isMaximized: win.isMaximized(),
  })
  const save = (): void => {
    if (win.isDestroyed()) return
    if (!win.isMaximized() && !win.isMinimized()) {
      normalBounds = win.getNormalBounds()
    }
    try {
      preferences.writeWindowBounds(snapshot())
    } catch {
      // Keep a window-geometry disk failure from closing active work.
    }
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  const close = (): void => {
    if (timer) clearTimeout(timer)
    save()
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', close)
  return () => {
    if (timer) clearTimeout(timer)
    win.removeListener('resize', schedule)
    win.removeListener('move', schedule)
    win.removeListener('close', close)
  }
}

function requestBoundary(intent: BoundaryIntent): void {
  void boundaryCoordinator?.request(intent).catch(() => undefined)
}

function emitBoundary(request: BoundaryRequest): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    throw new Error(
      'Open an application window before sending a boundary request.',
    )
  }
  win.webContents.send(IPC_CHANNELS.event, {
    topic: IPC_EVENTS.lifecycleBoundary,
    payload: request,
  })
}

interface UpdateBoundaryRuntime {
  stop(): Promise<void>
  restartAfterStop(): Promise<void>
}

interface UpdateBoundaryInstaller {
  canInstall(): Promise<boolean>
  installNow(): Promise<boolean>
}

/**
 * Stop scientific work for an update, but restore the supervisor if the
 * downloaded update disappears or Electron refuses to begin installation.
 *
 * @param approveQuit - Grants native quit authority after runtime shutdown.
 * @param revokeQuitApproval - Revokes quit authority after a failed
 *   installation.
 * @returns Resolves after Electron begins update installation.
 * @throws When installation cannot begin or runtime recovery fails.
 */
export async function installUpdateAtBoundary(
  runtime: UpdateBoundaryRuntime | null,
  installer: UpdateBoundaryInstaller,
  approveQuit: () => void,
  revokeQuitApproval: () => void,
): Promise<void> {
  if (!(await installer.canInstall())) {
    throw new Error('Download an update before installing it.')
  }

  let stopped = false
  try {
    await runtime?.stop()
    stopped = runtime !== null
    if (!(await installer.canInstall())) {
      throw new Error('Download the update again before installing it.')
    }
    approveQuit()
    if (!(await installer.installNow())) {
      throw new Error('Download the update again before installing it.')
    }
  } catch (error) {
    revokeQuitApproval()
    if (stopped && runtime) {
      try {
        await runtime.restartAfterStop()
      } catch {
        throw new Error(
          'Retry the scientific runtime before continuing after the failed update installation.',
        )
      }
    }
    throw error
  }
}

async function crossBoundary(intent: BoundaryIntent): Promise<void> {
  const win = mainWindow
  switch (intent) {
    case 'renderer-reload': {
      if (!win || win.isDestroyed())
        throw new Error('Open an application window before reloading it.')
      await invalidateActiveProject(sidecar ?? undefined)
      const reloadApproval = nativeUnloadApprovals.approve(win, intent)
      approvedReload = win
      try {
        win.webContents.reload()
      } catch (error) {
        nativeUnloadApprovals.revoke(reloadApproval)
        if (approvedReload === win) approvedReload = null
        throw error
      }
      return
    }
    case 'window-close': {
      if (!win || win.isDestroyed()) return
      // Treat closing the last window as quitting on every supported Linux
      // host, so stop the sidecar before the window goes away.
      await sidecar?.stop()
      await invalidateActiveProject(sidecar ?? undefined)
      approvedAppQuit = true
      approvedWindowClose = win
      const closeApproval = nativeUnloadApprovals.approve(win, intent)
      try {
        win.close()
      } catch (error) {
        nativeUnloadApprovals.revoke(closeApproval)
        if (approvedWindowClose === win) approvedWindowClose = null
        approvedAppQuit = false
        throw error
      }
      return
    }
    case 'app-quit': {
      await sidecar?.stop()
      await invalidateActiveProject(sidecar ?? undefined)
      approvedAppQuit = true
      approvedWindowClose = win
      const quitApproval =
        win && !win.isDestroyed()
          ? nativeUnloadApprovals.approve(win, intent)
          : null
      try {
        app.quit()
      } catch (error) {
        if (quitApproval) nativeUnloadApprovals.revoke(quitApproval)
        approvedAppQuit = false
        if (approvedWindowClose === win) approvedWindowClose = null
        throw error
      }
      return
    }
    case 'update-install': {
      let updateApproval: symbol | null = null
      await installUpdateAtBoundary(
        sidecar,
        autoUpdate,
        () => {
          approvedAppQuit = true
          approvedWindowClose = win
          if (win && !win.isDestroyed()) {
            updateApproval = nativeUnloadApprovals.approve(win, intent)
          }
        },
        () => {
          if (updateApproval) nativeUnloadApprovals.revoke(updateApproval)
          updateApproval = null
          approvedAppQuit = false
          approvedWindowClose = null
        },
      )
      return
    }
  }
}

/** Create the main application window. */
function createWindow(
  smokeCoordinator: PackageSmokeCoordinator | null = null,
): BrowserWindow {
  const preferences = preferenceStore
  const appearance = machinePreferences
  if (!preferences || !appearance) {
    throw new Error('Initialize machine preferences before creating a window.')
  }
  // Load the Supraspina icon from packaged resources in production and the source
  // packaging directory in development.
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(moduleDir, '../../packaging/icon.png')

  const rendererTarget = resolveRendererTarget(
    app.isPackaged,
    process.env['ELECTRON_RENDERER_URL'],
    rendererPath,
  )
  const bootUrl = rendererTarget.url
  const nativeDisplays = screen.getAllDisplays()
  const topology = captureDisplayTopology(
    nativeDisplays,
    screen.getPrimaryDisplay(),
  )
  const workAreas = nativeDisplays.map((display) => display.workArea)
  const initialPlacement = resolveStartupWindowPlacement(
    preferences.readWindowBounds(workAreas),
    preferences.readWindowPlacement(),
    topology,
  )
  const preferenceState = appearance.getState()

  const win = new BrowserWindow({
    ...initialPlacement.bounds,
    minWidth: initialPlacement.minimumSize.width,
    minHeight: initialPlacement.minimumSize.height,
    show: false,
    backgroundColor:
      preferenceState.resolvedTheme === 'dark' ? '#0e0f12' : '#fafbfc',
    autoHideMenuBar: true,
    title: 'Supraspina',
    icon: iconPath,
    // Draw the custom window controls inside the renderer's top bar.
    frame: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  const rendererWebContentsId = win.webContents.id
  expectedRenderer = {
    url: bootUrl,
    webContentsId: rendererWebContentsId,
  }
  mainWindow = win
  if (initialPlacement.isMaximized) win.maximize()
  const placementController = new WindowPlacementController({
    window: win,
    preferences,
    topology: displayTopologySource(),
    createOverlay: (options) => new BrowserWindow(options),
  })
  windowPlacement = placementController
  const geometryDispose = attachGeometryPersistence(win, preferences)
  disposeGeometry = geometryDispose
  const windowThemeDispose = appearance.onStateChanged((state) => {
    if (!win.isDestroyed()) {
      win.setBackgroundColor(
        state.resolvedTheme === 'dark' ? '#0e0f12' : '#fafbfc',
      )
    }
  })
  disposeWindowTheme = windowThemeDispose
  if (smokeCoordinator) {
    smokeCoordinator.observeWindow(
      win,
      session.fromPartition(UPDATER_PARTITION, { cache: false }),
    )
  }

  win.on('ready-to-show', () => win.show())

  // Keep the renderer's maximize/restore affordance in sync with the real
  // window state (the only main->renderer push outside the sidecar relay).
  const emitMaximized = (): void => {
    win.webContents.send(IPC_CHANNELS.event, {
      topic: IPC_EVENTS.windowMaximize,
      payload: win.isMaximized(),
    })
  }
  win.on('maximize', emitMaximized)
  win.on('unmaximize', emitMaximized)
  win.on('close', (event) => {
    if (approvedWindowClose === win) {
      approvedWindowClose = null
      return
    }
    event.preventDefault()
    requestBoundary('window-close')
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    if (expectedRenderer?.webContentsId === rendererWebContentsId) {
      expectedRenderer = null
    }
    if (approvedReload === win) approvedReload = null
    nativeUnloadApprovals.clearWindow(win)
    placementController.dispose()
    if (windowPlacement === placementController) windowPlacement = null
    geometryDispose()
    if (disposeGeometry === geometryDispose) disposeGeometry = null
    windowThemeDispose()
    if (disposeWindowTheme === windowThemeDispose) disposeWindowTheme = null
  })

  // Permit only the exact programmatic boot navigation. Deny renderer-driven
  // navigation and redirects.
  let initialNavigationAvailable = true
  win.webContents.on('will-navigate', (event, url) => {
    if (initialNavigationAvailable && url === bootUrl) {
      initialNavigationAvailable = false
      return
    }
    if (approvedReload === win && url === bootUrl) {
      approvedReload = null
      return
    }
    event.preventDefault()
    if (url === bootUrl) requestBoundary('renderer-reload')
  })
  win.webContents.on('did-finish-load', () => {
    initialNavigationAvailable = false
    if (approvedReload === win) approvedReload = null
    nativeUnloadApprovals.clearWindow(win)
  })
  win.webContents.on('will-prevent-unload', (event) => {
    nativeUnloadApprovals.permit(win, event)
  })
  win.webContents.on('will-redirect', (event) => event.preventDefault())
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  // Deny popups at the trust boundary. Open shipped links through the
  // purpose-bound external.openWeb IPC method.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        allowRendererPermission({
          permission,
          requestingUrl: Reflect.get(details, 'requestingUrl') as
            | string
            | undefined,
          isMainFrame: Reflect.get(details, 'isMainFrame') === true,
          matchesWindow: webContents === win.webContents,
          trustedUrl: bootUrl,
        }),
      )
    },
  )
  win.webContents.session.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) =>
      allowRendererPermission({
        permission,
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        matchesWindow: webContents === win.webContents,
        trustedUrl: bootUrl,
      }),
  )
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const exactMainFrame =
      details.resourceType === 'mainFrame' &&
      details.url === bootUrl &&
      (details.webContentsId === undefined ||
        details.webContentsId === win.webContents.id)
    if (exactMainFrame) {
      callback({
        responseHeaders: withRendererCsp(
          details.responseHeaders,
          rendererTarget.contentSecurityPolicy,
        ),
      })
      return
    }
    callback(
      details.responseHeaders
        ? { responseHeaders: details.responseHeaders }
        : {},
    )
  })
  win.webContents.on('before-input-event', (event, input) => {
    const reload =
      input.type === 'keyDown' &&
      (input.key === 'F5' ||
        ((input.control || input.meta) && input.key.toLowerCase() === 'r'))
    if (!reload) return
    event.preventDefault()
    requestBoundary('renderer-reload')
  })

  if (rendererTarget.kind === 'development') {
    void win.loadURL(bootUrl)
  } else {
    void win.loadFile(rendererPath)
  }
  return win
}

async function finishPackageSmoke(report: PackageSmokeReport): Promise<void> {
  const exitCode = report.ok ? 0 : 1
  packageSmokeExitCode = exitCode
  process.exitCode = exitCode
  const forceFailureExit = (): void => {
    packageSmokeExitCode = 1
    process.exitCode = 1
    app.exit(1)
  }
  const forcedExit = setTimeout(forceFailureExit, 5_000)
  // Keep this referenced timer as an independent fixed bound for stalled
  // pre-quit teardown. Complete a clean native exit during `will-quit`
  // before the bound can fire.
  try {
    await publishPackageSmokeReport(report)
    await crossBoundary('app-quit')
  } catch {
    clearTimeout(forcedExit)
    forceFailureExit()
  }
}

function bindIpcToCurrentWindow(): void {
  if (!sidecar || !boundaryCoordinator || !expectedRenderer) {
    throw new Error('Initialize application services before binding IPC.')
  }
  disposeIpc?.()
  disposeIpc = registerIpc(sidecar, {
    lifecycle: {
      request: (intent) => boundaryCoordinator!.request(intent),
      respond: (response) => boundaryCoordinator!.respond(response),
    },
    ...(machinePreferences ? { preferences: machinePreferences } : {}),
    ...(windowPlacement ? { windowPlacement } : {}),
    trustedRenderer: expectedRenderer,
    userDataPath: app.getPath('userData'),
    thirdPartyNoticesPath: join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      'THIRD_PARTY_NOTICES',
    ),
  })
}

app.whenReady().then(() => {
  preferenceStore = new PreferenceStore(
    join(app.getPath('userData'), 'machine-preferences.json'),
  )
  machinePreferences = new MachinePreferenceController(
    preferenceStore,
    nativeTheme,
  )
  sidecar = new Sidecar(app.getAppPath(), app.isPackaged)
  boundaryCoordinator = new BoundaryCoordinator({
    emit: emitBoundary,
    cross: crossBoundary,
  })
  createWindow(packageSmokeCoordinator)
  bindIpcToCurrentWindow()
  if (!packageSmokeCoordinator) {
    void sidecar.start().catch(() => undefined)
  }

  // Initialize updates after creating the window so the first state can reach
  // it. The package smoke blocks every request on the updater session itself,
  // so it keeps that stricter filter and never runs a launch check.
  initAutoUpdate(() => mainWindow, {
    automaticChecks: () =>
      machinePreferences?.getState().preferences.autoUpdateCheck ?? false,
    lastCheckedAt: () => preferenceStore?.readLastUpdateCheck() ?? null,
    recordCheck: (at) => preferenceStore?.writeLastUpdateCheck(at),
  })
  if (!packageSmokeCoordinator) {
    guardUpdateNetwork(
      session.fromPartition(UPDATER_PARTITION, { cache: false }),
    )
    void autoUpdate.checkOnLaunch()
  }

  if (packageSmokeCoordinator) {
    void packageSmokeCoordinator
      .run({
        paths: {
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          rendererPath,
          preloadPath,
          platform: process.platform,
          env: process.env,
        },
        sidecar,
      })
      .then(finishPackageSmoke)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(packageSmokeCoordinator)
      bindIpcToCurrentWindow()
    }
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', (event) => {
  if (approvedAppQuit || !boundaryCoordinator) return
  event.preventDefault()
  requestBoundary('app-quit')
})

app.on('will-quit', () => {
  nativeUnloadApprovals.clear()
  disposeIpc?.()
  disposeIpc = null
  expectedRenderer = null
  windowPlacement?.dispose()
  windowPlacement = null
  disposeGeometry?.()
  disposeGeometry = null
  disposeWindowTheme?.()
  disposeWindowTheme = null
  machinePreferences?.dispose()
  machinePreferences = null
  preferenceStore = null
  boundaryCoordinator?.dispose()
  boundaryCoordinator = null
  void sidecar?.stop().catch(() => undefined)
  sidecar = null
  finishPackageSmokeProcessExit(packageSmokeEnabled, packageSmokeExitCode ?? 1)
})

app.on('quit', (_event, exitCode) => {
  const requestedExitCode =
    exitCode === 0 ? (packageSmokeExitCode ?? 1) : exitCode
  finishPackageSmokeProcessExit(packageSmokeEnabled, requestedExitCode)
})
