import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import process from 'node:process'
import {
  DEFAULT_MACHINE_PREFERENCES,
  MACHINE_PREFERENCES_SCHEMA_VERSION,
  sanitizeMachinePreferences,
  validateMachinePreferencesPatch,
  type MachinePreferences,
  type MachinePreferencesPatch,
  type MachinePreferencesState,
  type ThemePreference,
} from '../shared/preferences'

/** The default restored window width in CSS pixels. */
export const DEFAULT_WINDOW_WIDTH = 1440
/** The default restored window height in CSS pixels. */
export const DEFAULT_WINDOW_HEIGHT = 900
/** The minimum persisted window width accepted during validation. */
export const MIN_SAVED_WIDTH = 1024
/** The minimum persisted window height accepted during validation. */
export const MIN_SAVED_HEIGHT = 700

/** Persisted normal window geometry. */
export interface SavedWindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}

/** The usable bounds of one connected display. */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/** The machine-local window placement policy. */
export type StoredWindowPlacement =
  | { mode: 'remember' }
  | { mode: 'primary' }
  | {
      mode: 'display'
      displayId: string
      identityGuard: string
      displayLabel?: string
    }

/**
 * The machine-level analysis tools: the Python 3.12 interpreter that runs
 * FreeSurfer's subregion segmentation (`subregionsPython`). It is a machine
 * setting, never a project configuration key, and main alone writes it
 * (through a native file dialog), so the renderer cannot name an
 * interpreter to run.
 */
export interface StoredAnalysisTools {
  subregionsPython: string
}

/** The update-check record that throttles automatic launch checks. */
export interface StoredUpdateState {
  /** The last update check, in milliseconds since the Unix epoch. */
  lastCheckedAt: number
}

interface DiskPreferences {
  schemaVersion: typeof MACHINE_PREFERENCES_SCHEMA_VERSION
  machine: Omit<MachinePreferences, 'schemaVersion'>
  window?: SavedWindowBounds
  placement?: StoredWindowPlacement
  analysis?: StoredAnalysisTools
  updates?: StoredUpdateState
}

/** The longest interpreter path main stores. */
const MAX_TOOL_PATH = 4096

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function machineFields(
  preferences: MachinePreferences,
): Omit<MachinePreferences, 'schemaVersion'> {
  const { schemaVersion: _schemaVersion, ...fields } = preferences
  void _schemaVersion
  return fields
}

function persistedWindowOnly(value: unknown): SavedWindowBounds | undefined {
  const candidate = record(value)
  if (
    !candidate ||
    !finite(candidate['width']) ||
    !finite(candidate['height'])
  ) {
    return undefined
  }
  return {
    ...(finite(candidate['x']) ? { x: candidate['x'] } : {}),
    ...(finite(candidate['y']) ? { y: candidate['y'] } : {}),
    width: candidate['width'],
    height: candidate['height'],
    isMaximized: candidate['isMaximized'] === true,
  }
}

function safeDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
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

function persistedPlacementOnly(
  value: unknown,
): StoredWindowPlacement | undefined {
  const candidate = record(value)
  if (!candidate) return undefined
  if (candidate['mode'] === 'remember') return { mode: 'remember' }
  if (candidate['mode'] === 'primary') return { mode: 'primary' }
  if (
    candidate['mode'] !== 'display' ||
    typeof candidate['displayId'] !== 'string' ||
    !/^display-[a-f0-9]{24}$/.test(candidate['displayId']) ||
    typeof candidate['identityGuard'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate['identityGuard'])
  ) {
    return undefined
  }
  const displayLabel = safeDisplayLabel(candidate['displayLabel'])
  return {
    mode: 'display',
    displayId: candidate['displayId'],
    identityGuard: candidate['identityGuard'],
    ...(displayLabel ? { displayLabel } : {}),
  }
}

function persistedAnalysisOnly(
  value: unknown,
): StoredAnalysisTools | undefined {
  const candidate = record(value)
  const path = candidate?.['subregionsPython']
  return typeof path === 'string' &&
    path.length > 0 &&
    path.length <= MAX_TOOL_PATH &&
    isAbsolute(path) &&
    !path.includes('\0')
    ? { subregionsPython: path }
    : undefined
}

function persistedUpdatesOnly(value: unknown): StoredUpdateState | undefined {
  const at = record(value)?.['lastCheckedAt']
  return finite(at) && at >= 0 ? { lastCheckedAt: at } : undefined
}

function machineCandidate(raw: unknown): unknown {
  const candidate = record(raw)
  if (!candidate) return {}
  return (
    record(candidate['machine']) ??
    record(candidate['preferences']) ??
    candidate
  )
}

function containingArea(
  x: number,
  y: number,
  workAreas: readonly WorkArea[],
): WorkArea | undefined {
  return workAreas.find(
    (area) =>
      x >= area.x &&
      y >= area.y &&
      x < area.x + area.width &&
      y < area.y + area.height,
  )
}

/**
 * Validate persisted normal geometry against the connected work areas.
 *
 * @returns Normalized bounds or `null` when validation fails.
 */
export function sanitizeWindowBounds(
  value: unknown,
  workAreas: readonly WorkArea[],
): SavedWindowBounds | null {
  const candidate = record(value)
  if (
    !candidate ||
    !finite(candidate['width']) ||
    !finite(candidate['height']) ||
    candidate['width'] < MIN_SAVED_WIDTH ||
    candidate['height'] < MIN_SAVED_HEIGHT
  ) {
    return null
  }

  const fallbackArea = workAreas[0]
  let width = Math.round(candidate['width'])
  let height = Math.round(candidate['height'])
  let x: number | undefined
  let y: number | undefined
  if (finite(candidate['x']) && finite(candidate['y'])) {
    const area = containingArea(candidate['x'], candidate['y'], workAreas)
    if (area) {
      width = Math.min(width, area.width)
      height = Math.min(height, area.height)
      x = Math.max(
        area.x,
        Math.min(Math.round(candidate['x']), area.x + area.width - width),
      )
      y = Math.max(
        area.y,
        Math.min(Math.round(candidate['y']), area.y + area.height - height),
      )
    }
  }
  if (x === undefined && fallbackArea) {
    width = Math.min(width, fallbackArea.width)
    height = Math.min(height, fallbackArea.height)
  }
  if (width < MIN_SAVED_WIDTH || height < MIN_SAVED_HEIGHT) return null
  return {
    width,
    height,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    isMaximized: candidate['isMaximized'] === true,
  }
}

/**
 * Atomic storage for preferences. Repair invalid fields independently on read;
 * never copy unknown fields into the next write.
 */
export class PreferenceStore {
  constructor(private readonly filePath: string) {}

  readMachinePreferences(): { preferences: MachinePreferences } {
    return {
      preferences: sanitizeMachinePreferences(machineCandidate(this.readRaw())),
    }
  }

  writeMachinePreferences(preferences: MachinePreferences): void {
    const safe = sanitizeMachinePreferences(preferences)
    this.writeDisk({
      ...this.readSafeDisk(),
      machine: machineFields(safe),
    })
  }

  patchMachinePreferences(patch: unknown): MachinePreferences {
    const safePatch = validateMachinePreferencesPatch(patch)
    const current = this.readMachinePreferences().preferences
    const next = sanitizeMachinePreferences({ ...current, ...safePatch })
    this.writeMachinePreferences(next)
    return next
  }

  resetMachinePreferences(): MachinePreferences {
    this.writeMachinePreferences(DEFAULT_MACHINE_PREFERENCES)
    return { ...DEFAULT_MACHINE_PREFERENCES }
  }

  readWindowBounds(workAreas: readonly WorkArea[]): SavedWindowBounds | null {
    return sanitizeWindowBounds(this.readRawRecord()?.['window'], workAreas)
  }

  writeWindowBounds(window: SavedWindowBounds): void {
    const safe = persistedWindowOnly(window)
    if (!safe) throw new TypeError('Provide valid saved window bounds.')
    this.writeDisk({ ...this.readSafeDisk(), window: safe })
  }

  readWindowPlacement(): StoredWindowPlacement {
    return (
      persistedPlacementOnly(this.readRawRecord()?.['placement']) ?? {
        mode: 'remember',
      }
    )
  }

  writeWindowPlacement(placement: StoredWindowPlacement): void {
    const safe = persistedPlacementOnly(placement)
    if (!safe) throw new TypeError('Provide a valid window placement.')
    this.writeDisk({ ...this.readSafeDisk(), placement: safe })
  }

  /** Read the subregions interpreter, or null when none is stored. */
  readSubregionsPython(): string | null {
    return (
      persistedAnalysisOnly(this.readRawRecord()?.['analysis'])
        ?.subregionsPython ?? null
    )
  }

  /**
   * Store the subregions interpreter, or clear it with null.
   *
   * @param path - An absolute path main chose, or null.
   * @throws TypeError when the path is not absolute or too long.
   */
  writeSubregionsPython(path: string | null): void {
    const { analysis: _analysis, ...rest } = this.readSafeDisk()
    void _analysis
    if (path === null) {
      this.writeDisk(rest)
      return
    }
    const safe = persistedAnalysisOnly({ subregionsPython: path })
    if (!safe) throw new TypeError('Provide a valid interpreter path.')
    this.writeDisk({ ...rest, analysis: safe })
  }

  /** Read the last update check time, or null when none is stored. */
  readLastUpdateCheck(): number | null {
    return (
      persistedUpdatesOnly(this.readRawRecord()?.['updates'])?.lastCheckedAt ??
      null
    )
  }

  /**
   * Store the time of an update check.
   *
   * @param at - The check time in milliseconds since the Unix epoch.
   * @throws TypeError when the time is not a finite, non-negative number.
   */
  writeLastUpdateCheck(at: number): void {
    const safe = persistedUpdatesOnly({ lastCheckedAt: at })
    if (!safe) throw new TypeError('Provide a valid update check time.')
    this.writeDisk({ ...this.readSafeDisk(), updates: safe })
  }

  private readRawRecord(): Record<string, unknown> | null {
    return record(this.readRaw())
  }

  private readRaw(): unknown {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
    } catch {
      return null
    }
  }

  private readSafeDisk(): DiskPreferences {
    const raw = this.readRawRecord()
    const machine = machineCandidate(raw)
    const window = persistedWindowOnly(raw?.['window'])
    const placement = persistedPlacementOnly(raw?.['placement'])
    const analysis = persistedAnalysisOnly(raw?.['analysis'])
    const updates = persistedUpdatesOnly(raw?.['updates'])
    return {
      schemaVersion: MACHINE_PREFERENCES_SCHEMA_VERSION,
      machine: machineFields(sanitizeMachinePreferences(machine)),
      ...(window ? { window } : {}),
      ...(placement ? { placement } : {}),
      ...(analysis ? { analysis } : {}),
      ...(updates ? { updates } : {}),
    }
  }

  private writeDisk(preferences: DiskPreferences): void {
    // Keep the temporary file unique per write, so a second application
    // instance cannot overwrite or rename this one mid-write.
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      // Node's writeFileSync applies mode only when it creates the file, so a
      // leftover temporary file would otherwise carry wider bits onto the real
      // file.
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.filePath)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // Clean up the temporary file without modifying the original preference file.
      }
      throw error
    }
  }
}

/** An abstraction over Electron's native theme state and update events. */
export interface NativeThemeHost {
  themeSource: ThemePreference
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

/** Immediate application of saved preferences and publication of live OS-theme changes. */
export class MachinePreferenceController {
  private readonly listeners = new Set<
    (state: MachinePreferencesState) => void
  >()
  private readonly onNativeThemeUpdated = (): void => {
    if (this.currentPreferences().theme === 'system') this.emit()
  }

  constructor(
    private readonly store: PreferenceStore,
    private readonly nativeTheme: NativeThemeHost,
  ) {
    this.applyTheme(this.currentPreferences().theme)
    nativeTheme.on('updated', this.onNativeThemeUpdated)
  }

  getState(): MachinePreferencesState {
    const { preferences } = this.store.readMachinePreferences()
    return {
      preferences: { ...preferences },
      resolvedTheme:
        preferences.theme === 'system'
          ? this.nativeTheme.shouldUseDarkColors
            ? 'dark'
            : 'light'
          : preferences.theme,
    }
  }

  patch(patch: unknown): MachinePreferencesState {
    const preferences = this.store.patchMachinePreferences(patch)
    this.applyTheme(preferences.theme)
    const state = this.getState()
    this.emit(state)
    return state
  }

  reset(): MachinePreferencesState {
    const preferences = this.store.resetMachinePreferences()
    this.applyTheme(preferences.theme)
    const state = this.getState()
    this.emit(state)
    return state
  }

  /** Read the machine's subregions interpreter (`subregionsPython`). */
  getSubregionsPython(): string | null {
    return this.store.readSubregionsPython()
  }

  /** Store or clear the machine's subregions interpreter. */
  setSubregionsPython(path: string | null): void {
    this.store.writeSubregionsPython(path)
  }

  onStateChanged(
    listener: (state: MachinePreferencesState) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.nativeTheme.removeListener('updated', this.onNativeThemeUpdated)
    this.listeners.clear()
  }

  private currentPreferences(): MachinePreferences {
    return this.store.readMachinePreferences().preferences
  }

  private applyTheme(theme: ThemePreference): void {
    this.nativeTheme.themeSource = theme
  }

  private emit(state = this.getState()): void {
    for (const listener of this.listeners) listener(state)
  }
}

/** A compile-time check of the public patch surface. */
export type { MachinePreferencesPatch }
