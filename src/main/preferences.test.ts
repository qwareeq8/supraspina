import { EventEmitter } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MACHINE_PREFERENCES } from '../shared/preferences'
import {
  MachinePreferenceController,
  PreferenceStore,
  sanitizeWindowBounds,
  type NativeThemeHost,
} from './preferences'

class FakeNativeTheme extends EventEmitter implements NativeThemeHost {
  themeSource: 'system' | 'light' | 'dark' = 'system'
  shouldUseDarkColors = true

  update(dark: boolean): void {
    this.shouldUseDarkColors = dark
    this.emit('updated')
  }
}

describe('main-owned machine preferences', () => {
  let directory = ''
  let file = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'supraspina-preferences-'))
    file = join(directory, 'machine-preferences.json')
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('writes mode 0600 without adopting a leftover temporary file', () => {
    // A crashed instance can leave a wider temporary file behind, and
    // writeFileSync applies its mode only when it creates the file, so those
    // bits must never reach the real file.
    writeFileSync(`${file}.tmp`, 'stale', { mode: 0o666 })
    chmodSync(`${file}.tmp`, 0o666)

    const store = new PreferenceStore(file)
    store.patchMachinePreferences({ theme: 'dark' })

    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(`${file}.tmp`).mode & 0o777).toBe(0o666)
  })

  it('writes through a unique temporary file and removes it after a failure', () => {
    const blocked = join(directory, 'occupied')
    mkdirSync(blocked)
    writeFileSync(join(blocked, 'occupant'), 'blocked')
    const blockedStore = new PreferenceStore(blocked)

    const temporaries = (['dark', 'light'] as const).map((theme) => {
      let failure: NodeJS.ErrnoException | null = null
      try {
        blockedStore.patchMachinePreferences({ theme })
      } catch (error) {
        failure = error as NodeJS.ErrnoException
      }
      expect(failure).not.toBeNull()
      return String(failure!.path)
    })

    expect(temporaries[0]).not.toBe(temporaries[1])
    for (const temporary of temporaries) {
      expect(temporary.startsWith(`${blocked}.`)).toBe(true)
      expect(temporary.endsWith('.tmp')).toBe(true)
      expect(existsSync(temporary)).toBe(false)
    }

    new PreferenceStore(file).patchMachinePreferences({ theme: 'dark' })
    expect(readFileSync(file, 'utf8')).toContain('"theme": "dark"')
    expect(
      readdirSync(directory).filter((entry) => entry.endsWith('.tmp')),
    ).toHaveLength(0)
  })

  it('defaults a missing, malformed, null, or array document without throwing', () => {
    const store = new PreferenceStore(file)
    expect(store.readMachinePreferences()).toEqual({
      preferences: DEFAULT_MACHINE_PREFERENCES,
    })
    for (const raw of ['{', 'null', '[]']) {
      writeFileSync(file, raw)
      expect(store.readMachinePreferences()).toEqual({
        preferences: DEFAULT_MACHINE_PREFERENCES,
      })
    }
  })

  it('retains valid fields, defaults invalid fields, and ignores unknown keys', () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 999,
        machine: {
          theme: 'light',
          density: 'cozy',
          failureEmphasis: 'loud',
          qcTone: null,
          showCommandHints: false,
          textScale: 135,
          reducedMotion: true,
          highContrast: 'yes',
          autoUpdateCheck: false,
          updatesDisabled: true,
          unknown: '/must/not/persist',
        },
      }),
    )
    const store = new PreferenceStore(file)
    expect(store.readMachinePreferences()).toEqual({
      preferences: {
        ...DEFAULT_MACHINE_PREFERENCES,
        theme: 'light',
        density: 'cozy',
        showCommandHints: false,
        reducedMotion: true,
        autoUpdateCheck: false,
      },
    })

    store.patchMachinePreferences({ textScale: '135' })
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >
    expect(persisted['schemaVersion']).toBe(1)
    expect(JSON.stringify(persisted)).not.toContain('unknown')
    expect(JSON.stringify(persisted)).not.toContain('must/not/persist')
    expect(JSON.stringify(persisted)).not.toContain('updatesDisabled')
  })

  it('rejects impossible or unknown live patches without replacing the stored record', () => {
    const store = new PreferenceStore(file)
    store.patchMachinePreferences({ theme: 'dark', highContrast: true })
    const before = readFileSync(file, 'utf8')
    expect(() => store.patchMachinePreferences({ theme: 'sepia' })).toThrow(
      /Provide a valid theme preference\./,
    )
    expect(() => store.patchMachinePreferences({ surprise: true })).toThrow(
      /Provide a valid preferences patch\./,
    )
    expect(() => store.patchMachinePreferences([])).toThrow(
      /Provide a valid preferences patch\./,
    )
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('defaults a corrupt placement policy without discarding valid machine fields', () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        machine: { theme: 'dark', density: 'comfortable' },
        placement: {
          mode: 'display',
          displayId: '7',
          identityGuard: 'not-a-guard',
        },
      }),
    )
    const store = new PreferenceStore(file)
    expect(store.readMachinePreferences().preferences).toMatchObject({
      theme: 'dark',
      density: 'comfortable',
    })
    expect(store.readWindowPlacement()).toEqual({ mode: 'remember' })
  })

  it('keeps the subregions interpreter as a machine setting apart from the renderer patch', () => {
    const store = new PreferenceStore(file)
    expect(store.readSubregionsPython()).toBeNull()
    store.writeSubregionsPython('/opt/py312/bin/python')
    store.patchMachinePreferences({ theme: 'dark' })
    store.writeWindowPlacement({ mode: 'primary' })
    expect(store.readSubregionsPython()).toBe('/opt/py312/bin/python')
    expect(store.readMachinePreferences().preferences).not.toHaveProperty(
      'subregionsPython',
    )
    expect(() =>
      store.patchMachinePreferences({ subregionsPython: '/bin/sh' }),
    ).toThrow(/valid preferences patch/)
    expect(() => store.writeSubregionsPython('python3')).toThrow(
      /interpreter path/,
    )
    const controller = new MachinePreferenceController(
      store,
      new FakeNativeTheme(),
    )
    controller.setSubregionsPython(null)
    expect(controller.getSubregionsPython()).toBeNull()
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty(
      'analysis',
    )
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        machine: { theme: 'light' },
        analysis: { subregionsPython: 'relative/python' },
      }),
    )
    expect(store.readSubregionsPython()).toBeNull()
  })

  it('checks for updates automatically by default', () => {
    expect(DEFAULT_MACHINE_PREFERENCES.autoUpdateCheck).toBe(true)
    const store = new PreferenceStore(file)
    expect(store.readMachinePreferences().preferences.autoUpdateCheck).toBe(
      true,
    )
    expect(() =>
      store.patchMachinePreferences({ updatesDisabled: true }),
    ).toThrow(/valid preferences patch/)
    expect(
      store.patchMachinePreferences({ autoUpdateCheck: false }).autoUpdateCheck,
    ).toBe(false)
  })

  it('keeps the last update check apart from the renderer patch', () => {
    const store = new PreferenceStore(file)
    expect(store.readLastUpdateCheck()).toBeNull()
    store.writeLastUpdateCheck(1_800_000_000_000)
    store.patchMachinePreferences({ theme: 'dark' })
    store.writeWindowPlacement({ mode: 'primary' })
    expect(store.readLastUpdateCheck()).toBe(1_800_000_000_000)
    expect(store.readMachinePreferences().preferences).not.toHaveProperty(
      'lastCheckedAt',
    )
    expect(() => store.patchMachinePreferences({ lastCheckedAt: 0 })).toThrow(
      /valid preferences patch/,
    )
    for (const invalid of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => store.writeLastUpdateCheck(invalid)).toThrow(
        /valid update check time/,
      )
    }
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        machine: { theme: 'light' },
        updates: { lastCheckedAt: 'yesterday' },
      }),
    )
    expect(store.readLastUpdateCheck()).toBeNull()
  })

  it('resolves System live while explicit Light and Dark remain stable', () => {
    const store = new PreferenceStore(file)
    const nativeTheme = new FakeNativeTheme()
    const controller = new MachinePreferenceController(store, nativeTheme)
    const changed = vi.fn()
    controller.onStateChanged(changed)

    expect(controller.getState().resolvedTheme).toBe('dark')
    nativeTheme.update(false)
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ resolvedTheme: 'light' }),
    )

    expect(controller.patch({ theme: 'dark' }).resolvedTheme).toBe('dark')
    nativeTheme.update(false)
    expect(controller.getState().resolvedTheme).toBe('dark')
    expect(controller.patch({ theme: 'light' }).resolvedTheme).toBe('light')
    expect(controller.reset().preferences).toEqual(DEFAULT_MACHINE_PREFERENCES)
    expect(nativeTheme.themeSource).toBe('system')
    controller.dispose()
  })

  it('preserves negative-coordinate bounds and rejects offscreen or undersized geometry', () => {
    const workAreas = [
      { x: -1920, y: 0, width: 1920, height: 1040 },
      { x: 0, y: 0, width: 2560, height: 1400 },
    ]
    expect(
      sanitizeWindowBounds(
        {
          x: -1700,
          y: 40,
          width: 1400,
          height: 900,
          isMaximized: true,
        },
        workAreas,
      ),
    ).toEqual({
      x: -1700,
      y: 40,
      width: 1400,
      height: 900,
      isMaximized: true,
    })
    expect(
      sanitizeWindowBounds(
        { x: 9000, y: 9000, width: 1440, height: 900 },
        workAreas,
      ),
    ).toEqual({ width: 1440, height: 900, isMaximized: false })
    expect(
      sanitizeWindowBounds({ width: 900, height: 600 }, workAreas),
    ).toBeNull()
  })
})
