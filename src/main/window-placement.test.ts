import type { BrowserWindowConstructorOptions, Rectangle } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { StoredWindowPlacement } from './preferences'
import {
  WindowPlacementController,
  captureDisplayTopology,
  clampBoundsToWorkArea,
  isWindowPlacementPreference,
  resolveStartupWindowPlacement,
  type DisplayTopologySource,
  type IdentifyOverlay,
  type NativeDisplayLike,
  type PlacementWindow,
  type WindowPlacementPreferences,
} from './window-placement'

function display(
  id: number,
  x: number,
  width = 1920,
  height = 1080,
  scaleFactor = 1,
  label = `Panel ${id}`,
): NativeDisplayLike {
  return {
    id,
    label,
    internal: id === 1,
    bounds: { x, y: 0, width, height },
    workArea: { x, y: 0, width, height: height - 40 },
    scaleFactor,
    size: { width, height },
  }
}

class FakePreferences implements WindowPlacementPreferences {
  placement: StoredWindowPlacement = { mode: 'remember' }

  readWindowPlacement(): StoredWindowPlacement {
    return this.placement
  }

  writeWindowPlacement(placement: StoredWindowPlacement): void {
    this.placement = placement
  }
}

class FakeWindow implements PlacementWindow {
  destroyed = false
  maximized = false
  minimized = false
  bounds: Rectangle = { x: 100, y: 100, width: 1400, height: 900 }
  minimum = { width: 0, height: 0 }
  setBounds = vi.fn((bounds: Rectangle) => {
    this.bounds = { ...bounds }
  })

  isDestroyed(): boolean {
    return this.destroyed
  }

  getNormalBounds(): Rectangle {
    return { ...this.bounds }
  }

  isMaximized(): boolean {
    return this.maximized
  }

  isMinimized(): boolean {
    return this.minimized
  }

  unmaximize(): void {
    this.maximized = false
  }

  maximize(): void {
    this.maximized = true
  }

  setMinimumSize(width: number, height: number): void {
    this.minimum = { width, height }
  }
}

class FakeTopology implements DisplayTopologySource {
  displays: NativeDisplayLike[]
  primary: NativeDisplayLike
  private readonly handlers = new Set<() => void>()

  constructor(displays: NativeDisplayLike[], primary = displays[0]!) {
    this.displays = displays
    this.primary = primary
  }

  snapshot() {
    return { displays: this.displays, primaryDisplay: this.primary }
  }

  subscribe(handler: () => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  change(displays: NativeDisplayLike[], primary = displays[0]!): void {
    this.displays = displays
    this.primary = primary
    for (const handler of this.handlers) handler()
  }

  listenerCount(): number {
    return this.handlers.size
  }
}

function overlay(): IdentifyOverlay & {
  options?: BrowserWindowConstructorOptions
  showInactive: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
} {
  let ready: (() => void) | null = null
  const item = {
    accessibleTitle: '',
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async () => undefined),
    once: vi.fn((_event: 'ready-to-show', handler: () => void) => {
      ready = handler
      queueMicrotask(() => ready?.())
    }),
    showInactive: vi.fn(),
    destroy: vi.fn(),
  }
  return item
}

function fixture(displays = [display(1, 0), display(2, 1920)]) {
  const preferences = new FakePreferences()
  const window = new FakeWindow()
  const topology = new FakeTopology(displays)
  const overlays: ReturnType<typeof overlay>[] = []
  const createOverlay = vi.fn((options: BrowserWindowConstructorOptions) => {
    void options
    const item = overlay()
    overlays.push(item)
    return item
  })
  const controller = new WindowPlacementController({
    window,
    preferences,
    topology,
    createOverlay,
  })
  return {
    controller,
    preferences,
    window,
    topology,
    overlays,
    createOverlay,
  }
}

describe('window placement topology', () => {
  it('keeps opaque display identity stable across reorder and numbers primary first', () => {
    const left = display(2, -1920)
    const primary = display(1, 0)
    const initial = captureDisplayTopology([left, primary], primary)
    const reordered = captureDisplayTopology([primary, left], primary)
    expect(initial.displays.map((item) => item.descriptor.id)).toEqual(
      reordered.displays.map((item) => item.descriptor.id),
    )
    expect(initial.displays[0]?.descriptor).toMatchObject({
      number: 1,
      primary: true,
    })
    expect(initial.displays[1]?.descriptor).toMatchObject({
      number: 2,
      primary: false,
    })
    expect(initial.displays.every((item) => item.descriptor.id !== '1')).toBe(
      true,
    )
  })

  it('reports native resolution, work area, and mixed scale safely', () => {
    const scaled = display(9, -2560, 1280, 720, 2, '  Studio\u0007 Panel  ')
    const topology = captureDisplayTopology([scaled], scaled)
    expect(topology.displays[0]?.descriptor).toMatchObject({
      label: 'Studio  Panel',
      resolution: { width: 2560, height: 1440 },
      workArea: { width: 1280, height: 680 },
      scaleFactor: 2,
    })
  })

  it('clamps negative, oversized, and offscreen rectangles to work area', () => {
    const area = { x: -1920, y: -40, width: 1920, height: 1040 }
    expect(
      clampBoundsToWorkArea(
        { x: -3000, y: -400, width: 2600, height: 1500 },
        area,
      ),
    ).toEqual(area)
    expect(
      clampBoundsToWorkArea(
        { x: -1800, y: 20, width: 1200, height: 800 },
        area,
      ),
    ).toEqual({ x: -1800, y: 20, width: 1200, height: 800 })
  })

  it('restores normal bounds and maximized state inside a negative-coordinate display', () => {
    const left = display(2, -1920)
    const primary = display(1, 0)
    const topology = captureDisplayTopology([primary, left], primary)
    const startup = resolveStartupWindowPlacement(
      {
        x: -1800,
        y: 60,
        width: 1500,
        height: 900,
        isMaximized: true,
      },
      { mode: 'remember' },
      topology,
    )
    expect(startup.bounds).toEqual({
      x: -1800,
      y: 60,
      width: 1500,
      height: 900,
    })
    expect(startup.isMaximized).toBe(true)
  })

  it('centers Primary and a selected display while respecting small work areas', () => {
    const primary = display(1, 0, 1280, 800)
    const external = display(2, 1280, 2560, 1440)
    const topology = captureDisplayTopology([primary, external], primary)
    const primaryStartup = resolveStartupWindowPlacement(
      null,
      { mode: 'primary' },
      topology,
    )
    expect(primaryStartup.bounds).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 760,
    })
    const selected = topology.displays.find(
      (item) => item.nativeId === external.id,
    )!
    const externalStartup = resolveStartupWindowPlacement(
      null,
      {
        mode: 'display',
        displayId: selected.descriptor.id,
        identityGuard: selected.identityGuard,
      },
      topology,
    )
    expect(externalStartup.bounds.x).toBeGreaterThanOrEqual(1280)
    expect(externalStartup.bounds.width).toBe(1440)
  })

  it('falls back visibly to primary when a selected display disappears', () => {
    const primary = display(1, 0)
    const external = display(2, 1920)
    const f = fixture([primary, external])
    const externalState = f.controller
      .getState()
      .displays.find((item) => !item.primary)!
    f.controller.setPreference({
      mode: 'display',
      displayId: externalState.id,
    })
    f.controller.moveNow()
    expect(f.window.bounds.x).toBeGreaterThanOrEqual(1920)

    f.topology.change([primary], primary)
    const state = f.controller.getState()
    expect(state).toMatchObject({
      fallbackReason: 'selected-display-unavailable',
      resolvedDisplayId: state.displays[0]?.id,
    })
    expect(state.unavailableDisplayLabel).toBe('Panel 2')
    expect(f.window.bounds.x).toBeGreaterThanOrEqual(0)
    expect(f.window.bounds.x + f.window.bounds.width).toBeLessThanOrEqual(1920)
    f.controller.dispose()
  })

  it('tracks a changed primary display and preserves maximized state on move', () => {
    const first = display(1, 0)
    const second = display(2, 1920)
    const f = fixture([first, second])
    f.controller.setPreference({ mode: 'primary' })
    f.window.maximized = true
    f.topology.change([first, second], second)
    expect(f.window.bounds.x).toBeGreaterThanOrEqual(1920)
    expect(f.window.maximized).toBe(true)
    expect(f.window.minimum).toEqual({ width: 1100, height: 700 })
    f.controller.dispose()
  })

  it('creates one focusless, sandboxed identify overlay per display and cleans up', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.controller.identifyDisplays()
    expect(f.createOverlay).toHaveBeenCalledTimes(2)
    for (const [index, call] of f.createOverlay.mock.calls.entries()) {
      expect(call[0]).toMatchObject({
        focusable: false,
        alwaysOnTop: true,
        title: `Display ${index + 1}`,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      })
    }
    await Promise.resolve()
    expect(
      f.overlays.every((item) => item.showInactive.mock.calls.length),
    ).toBe(true)
    vi.advanceTimersByTime(3_000)
    expect(f.overlays.every((item) => item.destroy.mock.calls.length)).toBe(
      true,
    )
    f.controller.dispose()
    expect(f.topology.listenerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('strictly rejects malformed placement requests', () => {
    expect(isWindowPlacementPreference({ mode: 'remember' })).toBe(true)
    expect(isWindowPlacementPreference({ mode: 'primary' })).toBe(true)
    expect(
      isWindowPlacementPreference({
        mode: 'display',
        displayId: 'display-000000000000000000000000',
      }),
    ).toBe(true)
    expect(
      isWindowPlacementPreference({
        mode: 'remember',
        displayId: 'display-000000000000000000000000',
      }),
    ).toBe(false)
    expect(
      isWindowPlacementPreference({ mode: 'display', displayId: '1' }),
    ).toBe(false)
    expect(isWindowPlacementPreference({ mode: 'floating' })).toBe(false)
  })
})
