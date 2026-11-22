/** Places Supraspina's single workspace window safely across changing display topologies. */

import { createHash } from 'node:crypto'
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron'
import type {
  WindowPlacementDisplay,
  WindowPlacementPreference,
  WindowPlacementState,
} from '../shared/contract'
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  type SavedWindowBounds,
  type StoredWindowPlacement,
} from './preferences'

const DISPLAY_ID_PATTERN = /^display-[a-f0-9]{24}$/
const IDENTIFY_DURATION_MS = 3_000
const IDENTIFY_WIDTH = 220
const IDENTIFY_HEIGHT = 150
const MINIMUM_WIDTH = 1_100
const MINIMUM_HEIGHT = 700

interface Size {
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

/** The Electron Display subset used by placement logic and fake layouts. */
export interface NativeDisplayLike {
  id: number
  label: string
  internal: boolean
  bounds: Rectangle
  workArea: Rectangle
  scaleFactor: number
  size: Size
  nativeOrigin?: Point
}

interface ConnectedDisplay {
  descriptor: WindowPlacementDisplay
  identityGuard: string
  nativeId: number
  bounds: Rectangle
  workArea: Rectangle
}

/** The connected displays in deterministic presentation order. */
export interface DisplayTopology {
  displays: ConnectedDisplay[]
  primaryDisplayId: string
}

/** Safe initial geometry and public placement state. */
export interface StartupWindowPlacement {
  bounds: Rectangle
  isMaximized: boolean
  minimumSize: Size
  state: WindowPlacementState
}

/** An abstraction over persisted window placement reads and writes. */
export interface WindowPlacementPreferences {
  readWindowPlacement(): StoredWindowPlacement
  writeWindowPlacement(placement: StoredWindowPlacement): void
}

/** An abstraction over the BrowserWindow operations used by placement control. */
export interface PlacementWindow {
  isDestroyed(): boolean
  getNormalBounds(): Rectangle
  isMaximized(): boolean
  isMinimized(): boolean
  unmaximize(): void
  maximize(): void
  setBounds(bounds: Rectangle): void
  setMinimumSize(width: number, height: number): void
}

/** A source of display snapshots and topology-change subscriptions. */
export interface DisplayTopologySource {
  snapshot(): {
    displays: readonly NativeDisplayLike[]
    primaryDisplay: NativeDisplayLike
  }
  subscribe(handler: () => void): () => void
}

interface NavigationEvent {
  preventDefault(): void
}

/** An abstraction over a secure display-identification overlay window. */
export interface IdentifyOverlay {
  accessibleTitle: string
  readonly webContents: {
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(event: 'will-navigate', handler: (event: NavigationEvent) => void): void
  }
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  once(event: 'ready-to-show', handler: () => void): void
  showInactive(): void
  destroy(): void
}

/** Live window placement and display identification. */
export interface WindowPlacementControllerOptions {
  window: PlacementWindow
  preferences: WindowPlacementPreferences
  topology: DisplayTopologySource
  createOverlay(options: BrowserWindowConstructorOptions): IdentifyOverlay
}

function finite(value: number): boolean {
  return Number.isFinite(value)
}

function validRectangle(value: Rectangle): boolean {
  return (
    finite(value.x) &&
    finite(value.y) &&
    finite(value.width) &&
    finite(value.height) &&
    value.width > 0 &&
    value.height > 0
  )
}

function safeLabel(value: string): string | undefined {
  const label = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
    .slice(0, 80)
  return label || undefined
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function nativeResolution(display: NativeDisplayLike): Size {
  return {
    width: Math.max(
      1,
      Math.round(
        (finite(display.size.width)
          ? display.size.width
          : display.bounds.width) * display.scaleFactor,
      ),
    ),
    height: Math.max(
      1,
      Math.round(
        (finite(display.size.height)
          ? display.size.height
          : display.bounds.height) * display.scaleFactor,
      ),
    ),
  }
}

function displayIdentityGuard(display: NativeDisplayLike): string {
  const resolution = nativeResolution(display)
  const dimensions = [resolution.width, resolution.height].sort((a, b) => a - b)
  return digest(
    JSON.stringify({
      internal: display.internal,
      label: safeLabel(display.label)?.toLowerCase() ?? '',
      nativeDimensions: dimensions,
    }),
  )
}

function opaqueDisplayId(display: NativeDisplayLike, guard: string): string {
  return `display-${digest(`${display.id}\u0000${guard}`).slice(0, 24)}`
}

function compareDisplays(
  left: ConnectedDisplay,
  right: ConnectedDisplay,
): number {
  return (
    left.bounds.x - right.bounds.x ||
    left.bounds.y - right.bounds.y ||
    left.nativeId - right.nativeId
  )
}

/**
 * Build a deterministic renderer-safe snapshot from an Electron topology.
 *
 * @returns An opaque, deterministically ordered display topology.
 * @throws When no valid display remains after validation.
 */
export function captureDisplayTopology(
  displays: readonly NativeDisplayLike[],
  primaryDisplay: NativeDisplayLike,
): DisplayTopology {
  const connected = displays
    .filter(
      (display) =>
        finite(display.id) &&
        finite(display.scaleFactor) &&
        display.scaleFactor > 0 &&
        validRectangle(display.bounds) &&
        validRectangle(display.workArea),
    )
    .map((display): ConnectedDisplay => {
      const identityGuard = displayIdentityGuard(display)
      const resolution = nativeResolution(display)
      const label = safeLabel(display.label)
      return {
        descriptor: {
          id: opaqueDisplayId(display, identityGuard),
          number: 0,
          primary: false,
          resolution,
          workArea: {
            width: Math.round(display.workArea.width),
            height: Math.round(display.workArea.height),
          },
          scaleFactor: display.scaleFactor,
          ...(label ? { label } : {}),
        },
        identityGuard,
        nativeId: display.id,
        bounds: { ...display.bounds },
        workArea: { ...display.workArea },
      }
    })

  const first = connected[0]
  if (!first)
    throw new Error('Connect a valid display before opening Supraspina.')
  const primaryGuard = displayIdentityGuard(primaryDisplay)
  const primaryId = opaqueDisplayId(primaryDisplay, primaryGuard)
  const primary =
    connected.find(
      (display) =>
        display.descriptor.id === primaryId &&
        display.identityGuard === primaryGuard,
    ) ?? first
  const ordered = [
    primary,
    ...connected.filter((display) => display !== primary).sort(compareDisplays),
  ]
  ordered.forEach((display, index) => {
    display.descriptor.number = index + 1
    display.descriptor.primary = display === primary
  })
  return { displays: ordered, primaryDisplayId: primary.descriptor.id }
}

function primaryDisplay(topology: DisplayTopology): ConnectedDisplay {
  return (
    topology.displays.find(
      (display) => display.descriptor.id === topology.primaryDisplayId,
    ) ?? topology.displays[0]!
  )
}

function selectedDisplay(
  placement: StoredWindowPlacement,
  topology: DisplayTopology,
): ConnectedDisplay | null {
  if (placement.mode !== 'display') return null
  return (
    topology.displays.find(
      (display) =>
        display.descriptor.id === placement.displayId &&
        display.identityGuard === placement.identityGuard,
    ) ?? null
  )
}

function targetDisplay(
  placement: StoredWindowPlacement,
  topology: DisplayTopology,
): {
  display: ConnectedDisplay
  fallbackReason: WindowPlacementState['fallbackReason']
} {
  if (placement.mode === 'display') {
    const selected = selectedDisplay(placement, topology)
    return selected
      ? { display: selected, fallbackReason: null }
      : {
          display: primaryDisplay(topology),
          fallbackReason: 'selected-display-unavailable',
        }
  }
  return { display: primaryDisplay(topology), fallbackReason: null }
}

function intersectionArea(left: Rectangle, right: Rectangle): number {
  const width =
    Math.min(left.x + left.width, right.x + right.width) -
    Math.max(left.x, right.x)
  const height =
    Math.min(left.y + left.height, right.y + right.height) -
    Math.max(left.y, right.y)
  return Math.max(0, width) * Math.max(0, height)
}

function displayForBounds(
  bounds: Rectangle,
  topology: DisplayTopology,
): ConnectedDisplay {
  let best = primaryDisplay(topology)
  let bestArea = 0
  for (const display of topology.displays) {
    const area = intersectionArea(bounds, display.workArea)
    if (area > bestArea) {
      best = display
      bestArea = area
    }
  }
  return best
}

/**
 * Clamp window bounds completely inside one display work area.
 *
 * @returns Rounded bounds inside the work area.
 */
export function clampBoundsToWorkArea(
  bounds: Rectangle,
  workArea: Rectangle,
): Rectangle {
  const width = Math.min(
    Math.round(workArea.width),
    Math.max(1, Math.round(bounds.width)),
  )
  const height = Math.min(
    Math.round(workArea.height),
    Math.max(1, Math.round(bounds.height)),
  )
  const minimumX = Math.round(workArea.x)
  const minimumY = Math.round(workArea.y)
  return {
    x: Math.max(
      minimumX,
      Math.min(
        Math.round(workArea.x + workArea.width - width),
        Math.round(bounds.x),
      ),
    ),
    y: Math.max(
      minimumY,
      Math.min(
        Math.round(workArea.y + workArea.height - height),
        Math.round(bounds.y),
      ),
    ),
    width,
    height,
  }
}

function centeredBounds(size: Size, workArea: Rectangle): Rectangle {
  return clampBoundsToWorkArea(
    {
      x: workArea.x + (workArea.width - size.width) / 2,
      y: workArea.y + (workArea.height - size.height) / 2,
      ...size,
    },
    workArea,
  )
}

function supportedWorkspaceBounds(
  bounds: Rectangle,
  workArea: Rectangle,
): Rectangle {
  return {
    ...bounds,
    width: Math.max(
      Math.min(MINIMUM_WIDTH, workArea.width),
      Math.min(bounds.width, workArea.width),
    ),
    height: Math.max(
      Math.min(MINIMUM_HEIGHT, workArea.height),
      Math.min(bounds.height, workArea.height),
    ),
  }
}

function publicPreference(
  placement: StoredWindowPlacement,
): WindowPlacementPreference {
  return placement.mode === 'display'
    ? { mode: 'display', displayId: placement.displayId }
    : { mode: placement.mode }
}

function placementState(
  placement: StoredWindowPlacement,
  topology: DisplayTopology,
  currentBounds?: Rectangle,
): WindowPlacementState {
  const target =
    placement.mode === 'remember' && currentBounds
      ? {
          display: displayForBounds(currentBounds, topology),
          fallbackReason: null,
        }
      : targetDisplay(placement, topology)
  return {
    preference: publicPreference(placement),
    displays: topology.displays.map((display) => ({
      ...display.descriptor,
      resolution: { ...display.descriptor.resolution },
      workArea: { ...display.descriptor.workArea },
    })),
    resolvedDisplayId: target.display.descriptor.id,
    fallbackReason: target.fallbackReason,
    ...(target.fallbackReason &&
    placement.mode === 'display' &&
    placement.displayLabel
      ? { unavailableDisplayLabel: placement.displayLabel }
      : {}),
  }
}

/** Resolve persisted bounds and placement policy for safe startup. */
export function resolveStartupWindowPlacement(
  savedBounds: SavedWindowBounds | null,
  placement: StoredWindowPlacement,
  topology: DisplayTopology,
): StartupWindowPlacement {
  const size = {
    width: savedBounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: savedBounds?.height ?? DEFAULT_WINDOW_HEIGHT,
  }
  let display: ConnectedDisplay
  let bounds: Rectangle
  if (
    placement.mode === 'remember' &&
    savedBounds?.x !== undefined &&
    savedBounds.y !== undefined
  ) {
    const requested = { x: savedBounds.x, y: savedBounds.y, ...size }
    display = displayForBounds(requested, topology)
    bounds = clampBoundsToWorkArea(
      supportedWorkspaceBounds(requested, display.workArea),
      display.workArea,
    )
  } else {
    display = targetDisplay(placement, topology).display
    bounds = centeredBounds(
      supportedWorkspaceBounds(
        { x: display.workArea.x, y: display.workArea.y, ...size },
        display.workArea,
      ),
      display.workArea,
    )
  }
  return {
    bounds,
    isMaximized: savedBounds?.isMaximized === true,
    minimumSize: {
      width: Math.min(MINIMUM_WIDTH, display.workArea.width),
      height: Math.min(MINIMUM_HEIGHT, display.workArea.height),
    },
    state: placementState(placement, topology, bounds),
  }
}

/** Validate one untrusted public window placement preference. */
export function isWindowPlacementPreference(
  value: unknown,
): value is WindowPlacementPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  if (candidate['mode'] === 'remember' || candidate['mode'] === 'primary') {
    return keys.length === 1 && keys[0] === 'mode'
  }
  return (
    candidate['mode'] === 'display' &&
    keys.length === 2 &&
    keys[0] === 'displayId' &&
    keys[1] === 'mode' &&
    typeof candidate['displayId'] === 'string' &&
    DISPLAY_ID_PATTERN.test(candidate['displayId'])
  )
}

function identifyDocument(number: number): string {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Display ${number}</title><style>
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#17181c;color:#fff}
body{display:grid;place-items:center;font-family:system-ui,sans-serif}
main{font-size:96px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
</style></head><body><main role="status" aria-label="Display ${number}">${number}</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Control of live placement, topology changes, and overlays from the main process. */
export class WindowPlacementController {
  private readonly listeners = new Set<(state: WindowPlacementState) => void>()
  private readonly unsubscribeTopology: () => void
  private overlays: IdentifyOverlay[] = []
  private overlayTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly options: WindowPlacementControllerOptions) {
    this.unsubscribeTopology = options.topology.subscribe(() => {
      this.handleTopologyChange()
    })
  }

  getState(): WindowPlacementState {
    const topology = this.currentTopology()
    const bounds = this.options.window.isDestroyed()
      ? undefined
      : this.options.window.getNormalBounds()
    return placementState(
      this.options.preferences.readWindowPlacement(),
      topology,
      bounds,
    )
  }

  setPreference(preference: WindowPlacementPreference): WindowPlacementState {
    if (!isWindowPlacementPreference(preference)) {
      throw new TypeError('Provide a valid window placement preference.')
    }
    if (preference.mode === 'display') {
      const display = this.currentTopology().displays.find(
        (candidate) => candidate.descriptor.id === preference.displayId,
      )
      if (!display) throw new TypeError('Select a connected display.')
      this.options.preferences.writeWindowPlacement({
        mode: 'display',
        displayId: display.descriptor.id,
        identityGuard: display.identityGuard,
        ...(display.descriptor.label
          ? { displayLabel: display.descriptor.label }
          : {}),
      })
    } else {
      this.options.preferences.writeWindowPlacement({ mode: preference.mode })
    }
    const state = this.getState()
    this.emit(state)
    return state
  }

  resetPreference(): WindowPlacementState {
    return this.setPreference({ mode: 'remember' })
  }

  moveNow(): WindowPlacementState {
    this.applyCurrentPlacement(true)
    const state = this.getState()
    this.emit(state)
    return state
  }

  identifyDisplays(): void {
    this.destroyOverlays()
    for (const display of this.currentTopology().displays) {
      const bounds = centeredBounds(
        { width: IDENTIFY_WIDTH, height: IDENTIFY_HEIGHT },
        display.workArea,
      )
      const overlay = this.options.createOverlay({
        ...bounds,
        show: false,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        title: `Display ${display.descriptor.number}`,
        backgroundColor: '#17181c',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          spellcheck: false,
        },
      })
      overlay.accessibleTitle = `Display ${display.descriptor.number}`
      overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      overlay.webContents.on('will-navigate', (event) => event.preventDefault())
      overlay.once('ready-to-show', () => {
        if (!this.disposed && !overlay.isDestroyed()) overlay.showInactive()
      })
      void overlay
        .loadURL(identifyDocument(display.descriptor.number))
        .catch(() => {
          if (!overlay.isDestroyed()) overlay.destroy()
        })
      this.overlays.push(overlay)
    }
    this.overlayTimer = setTimeout(
      () => this.destroyOverlays(),
      IDENTIFY_DURATION_MS,
    )
  }

  onStateChanged(listener: (state: WindowPlacementState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeTopology()
    this.listeners.clear()
    this.destroyOverlays()
  }

  private currentTopology(): DisplayTopology {
    const snapshot = this.options.topology.snapshot()
    return captureDisplayTopology(snapshot.displays, snapshot.primaryDisplay)
  }

  private applyCurrentPlacement(center: boolean): void {
    const window = this.options.window
    if (window.isDestroyed()) return
    const topology = this.currentTopology()
    const placement = this.options.preferences.readWindowPlacement()
    const current = window.getNormalBounds()
    let target: ConnectedDisplay
    let next: Rectangle
    if (placement.mode === 'remember') {
      target = displayForBounds(current, topology)
      const visible = intersectionArea(current, target.workArea) > 0
      const supported = supportedWorkspaceBounds(current, target.workArea)
      next =
        center && !visible
          ? centeredBounds(supported, target.workArea)
          : clampBoundsToWorkArea(supported, target.workArea)
    } else {
      target = targetDisplay(placement, topology).display
      const currentDisplay = displayForBounds(current, topology)
      const supported = supportedWorkspaceBounds(current, target.workArea)
      next =
        center ||
        intersectionArea(current, target.workArea) === 0 ||
        currentDisplay.descriptor.id !== target.descriptor.id
          ? centeredBounds(supported, target.workArea)
          : clampBoundsToWorkArea(supported, target.workArea)
    }
    window.setMinimumSize(
      Math.round(Math.min(MINIMUM_WIDTH, target.workArea.width)),
      Math.round(Math.min(MINIMUM_HEIGHT, target.workArea.height)),
    )
    if (
      current.x === next.x &&
      current.y === next.y &&
      current.width === next.width &&
      current.height === next.height
    ) {
      return
    }
    const maximized = window.isMaximized()
    if (maximized) window.unmaximize()
    window.setBounds(next)
    if (maximized) window.maximize()
  }

  private handleTopologyChange(): void {
    if (this.disposed) return
    this.destroyOverlays()
    try {
      this.applyCurrentPlacement(false)
      this.emit(this.getState())
    } catch {
      // Keep a transient empty display snapshot from crashing or destroying the
      // scientific workspace; rely on Electron normally guaranteeing at least
      // one display.
    }
  }

  private emit(state: WindowPlacementState): void {
    for (const listener of this.listeners) listener(state)
  }

  private destroyOverlays(): void {
    if (this.overlayTimer) clearTimeout(this.overlayTimer)
    this.overlayTimer = null
    for (const overlay of this.overlays.splice(0)) {
      if (!overlay.isDestroyed()) overlay.destroy()
    }
  }
}
