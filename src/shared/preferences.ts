/**
 * Shares versioned machine-local preferences among main, preload, and renderer.
 *
 * These values cover application presentation and behavior only. Project paths,
 * document state, scientific settings, and clinical data stay out of this
 * schema.
 */

/** The only accepted machine-preferences schema version. */
export const MACHINE_PREFERENCES_SCHEMA_VERSION = 1 as const

/** The persisted application color-theme preference. */
export type ThemePreference = 'system' | 'light' | 'dark'
/** The resolved effective application color theme. */
export type ResolvedTheme = 'light' | 'dark'
/** The persisted application layout density. */
export type DensityPreference = 'compact' | 'cozy' | 'comfortable'
/** The persisted visual emphasis for failures. */
export type FailureEmphasisPreference = 'whisper' | 'notice' | 'triage'
/** The persisted presentation tone for QC content. */
export type QcTonePreference = 'shell' | 'notebook'
/** The persisted interface text scale. */
export type TextScalePreference = '100' | '115' | '135'

/** The complete validated preference record returned to the renderer. */
export interface MachinePreferences {
  schemaVersion: typeof MACHINE_PREFERENCES_SCHEMA_VERSION
  theme: ThemePreference
  density: DensityPreference
  failureEmphasis: FailureEmphasisPreference
  qcTone: QcTonePreference
  showCommandHints: boolean
  textScale: TextScalePreference
  reducedMotion: boolean
  highContrast: boolean
  /**
   * Check the public GitHub Releases at most once a day at launch. When off,
   * Supraspina contacts the update feed only when the operator asks.
   */
  autoUpdateCheck: boolean
}

/** A partial live update to machine-local preferences. */
export type MachinePreferencesPatch = Partial<
  Omit<MachinePreferences, 'schemaVersion'>
>

/** The main-resolved projection that includes the current OS theme. */
export interface MachinePreferencesState {
  preferences: MachinePreferences
  resolvedTheme: ResolvedTheme
}

/** The canonical machine-local preference defaults. */
export const DEFAULT_MACHINE_PREFERENCES: MachinePreferences = {
  schemaVersion: MACHINE_PREFERENCES_SCHEMA_VERSION,
  theme: 'system',
  density: 'compact',
  failureEmphasis: 'notice',
  qcTone: 'notebook',
  showCommandHints: true,
  textScale: '100',
  reducedMotion: false,
  highContrast: false,
  autoUpdateCheck: true,
}

const ALLOWED_KEYS = new Set<keyof MachinePreferencesPatch>([
  'theme',
  'density',
  'failureEmphasis',
  'qcTone',
  'showCommandHints',
  'textScale',
  'reducedMotion',
  'highContrast',
  'autoUpdateCheck',
])

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

/**
 * Retain every valid stored field and replace each invalid field independently.
 * Ignore unknown keys during stored-record repair.
 */
export function sanitizeMachinePreferences(value: unknown): MachinePreferences {
  const candidate = record(value) ?? {}
  return {
    schemaVersion: MACHINE_PREFERENCES_SCHEMA_VERSION,
    theme: oneOf(candidate['theme'], ['system', 'light', 'dark'])
      ? candidate['theme']
      : DEFAULT_MACHINE_PREFERENCES.theme,
    density: oneOf(candidate['density'], ['compact', 'cozy', 'comfortable'])
      ? candidate['density']
      : DEFAULT_MACHINE_PREFERENCES.density,
    failureEmphasis: oneOf(candidate['failureEmphasis'], [
      'whisper',
      'notice',
      'triage',
    ])
      ? candidate['failureEmphasis']
      : DEFAULT_MACHINE_PREFERENCES.failureEmphasis,
    qcTone: oneOf(candidate['qcTone'], ['shell', 'notebook'])
      ? candidate['qcTone']
      : DEFAULT_MACHINE_PREFERENCES.qcTone,
    showCommandHints:
      typeof candidate['showCommandHints'] === 'boolean'
        ? candidate['showCommandHints']
        : DEFAULT_MACHINE_PREFERENCES.showCommandHints,
    textScale: oneOf(candidate['textScale'], ['100', '115', '135'])
      ? candidate['textScale']
      : DEFAULT_MACHINE_PREFERENCES.textScale,
    reducedMotion:
      typeof candidate['reducedMotion'] === 'boolean'
        ? candidate['reducedMotion']
        : DEFAULT_MACHINE_PREFERENCES.reducedMotion,
    highContrast:
      typeof candidate['highContrast'] === 'boolean'
        ? candidate['highContrast']
        : DEFAULT_MACHINE_PREFERENCES.highContrast,
    autoUpdateCheck:
      typeof candidate['autoUpdateCheck'] === 'boolean'
        ? candidate['autoUpdateCheck']
        : DEFAULT_MACHINE_PREFERENCES.autoUpdateCheck,
  }
}

/**
 * Strictly validate an untrusted renderer patch.
 *
 * Repair stored records field by field, but require an accepted live mutation
 * to be exact. Reject every unknown key and impossible value.
 *
 * @throws TypeError when the patch is empty, unknown, or invalid.
 */
export function validateMachinePreferencesPatch(
  value: unknown,
): MachinePreferencesPatch {
  const candidate = record(value)
  if (!candidate) throw new TypeError('Provide a valid preferences patch.')
  const keys = Object.keys(candidate)
  if (
    keys.length === 0 ||
    keys.some((key) => !ALLOWED_KEYS.has(key as keyof MachinePreferencesPatch))
  ) {
    throw new TypeError('Provide a valid preferences patch.')
  }

  for (const [key, field] of Object.entries(candidate)) {
    const valid =
      (key === 'theme' && oneOf(field, ['system', 'light', 'dark'])) ||
      (key === 'density' && oneOf(field, ['compact', 'cozy', 'comfortable'])) ||
      (key === 'failureEmphasis' &&
        oneOf(field, ['whisper', 'notice', 'triage'])) ||
      (key === 'qcTone' && oneOf(field, ['shell', 'notebook'])) ||
      (key === 'textScale' && oneOf(field, ['100', '115', '135'])) ||
      ([
        'showCommandHints',
        'reducedMotion',
        'highContrast',
        'autoUpdateCheck',
      ].includes(key) &&
        typeof field === 'boolean')
    if (!valid) throw new TypeError(`Provide a valid ${key} preference.`)
  }
  return { ...candidate } as MachinePreferencesPatch
}

/**
 * Validate a complete state crossing the context bridge.
 *
 * @returns True when the value is a complete canonical state.
 */
export function isMachinePreferencesState(
  value: unknown,
): value is MachinePreferencesState {
  const candidate = record(value)
  const keys = candidate ? Object.keys(candidate) : []
  if (
    !candidate ||
    keys.length !== 2 ||
    keys.some((key) => key !== 'preferences' && key !== 'resolvedTheme') ||
    !oneOf(candidate['resolvedTheme'], ['light', 'dark'])
  ) {
    return false
  }
  const preferences = record(candidate['preferences'])
  if (
    !preferences ||
    preferences['schemaVersion'] !== MACHINE_PREFERENCES_SCHEMA_VERSION
  ) {
    return false
  }
  const sanitized = sanitizeMachinePreferences(preferences)
  return (
    Object.keys(preferences).length === Object.keys(sanitized).length &&
    Object.entries(sanitized).every(
      ([key, field]) => preferences[key] === field,
    )
  )
}
