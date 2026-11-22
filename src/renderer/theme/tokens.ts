/**
 * The design tokens used throughout the Supraspina console. Status colors are
 * shared between the matrix and shell. `accentInk` holds at least 4.5:1
 * contrast against the accent.
 */

import type { ChipStatus } from '../../shared/types'
import type { DensityPreference, ResolvedTheme } from '../../shared/preferences'

/** Every color token available to a theme. */
export interface Theme {
  bg: string
  surface: string
  surface2: string
  surface3: string
  surface4: string
  border: string
  borderSoft: string
  borderStrong: string
  text: string
  textSoft: string
  textStrong: string
  dim: string
  dimmer: string
  /**
   * Keep the smallest de-emphasized text at 4.5:1 or better on primary surfaces.
   * Reserve `dimmer` for non-text decoration.
   */
  dimText: string
  accent: string
  accentInk: string
  accentSoft: string
  accentLine: string
  accentDim: string
  pending: string
  pendingSoft: string
  running: string
  runningSoft: string
  done: string
  doneSoft: string
  failed: string
  failedSoft: string
  skipped: string
  skippedSoft: string
  warning: string
  warningSoft: string
  /** Set the modal backdrop scrim. */
  scrim: string
  shadow: string
}

/** The name of a resolved theme. */
export type ThemeName = ResolvedTheme

const dark: Theme = {
  bg: '#0e0f12',
  surface: '#15171c',
  surface2: '#1c1f26',
  surface3: '#23262e',
  surface4: '#2c323d',
  border: '#262932',
  borderSoft: '#1e2128',
  borderStrong: '#3a414e',
  text: '#e6e8ec',
  textSoft: '#c4c8d0',
  textStrong: '#f4f5f7',
  dim: '#8b8f99',
  dimmer: '#5a5e68',
  dimText: '#868b95',
  accent: '#46b98a',
  accentInk: '#07140e',
  accentSoft: '#14271d',
  accentLine: '#2e6b4f',
  accentDim: '#3e9e7b',
  pending: '#5a5e68',
  pendingSoft: 'rgba(90,94,104,0.16)',
  running: '#5b8def',
  runningSoft: '#1d2942',
  done: '#3da671',
  doneSoft: '#152e22',
  // Keep text and glyph contrast safe on every dark surface tier.
  failed: '#e87878',
  failedSoft: '#3a1a1a',
  skipped: '#7a7e88',
  skippedSoft: 'rgba(122,126,136,0.16)',
  warning: '#d4a14d',
  warningSoft: 'rgba(212,161,77,0.16)',
  scrim: 'rgba(0,0,0,0.5)',
  shadow: '0 12px 32px rgba(0,0,0,0.5)',
}

const light: Theme = {
  bg: '#fafbfc',
  surface: '#ffffff',
  surface2: '#f4f5f7',
  surface3: '#e9ebf0',
  surface4: '#d8dce2',
  border: '#dde0e6',
  borderSoft: '#e8eaef',
  borderStrong: '#b6bcc4',
  text: '#1a1d23',
  textSoft: '#3a3d44',
  textStrong: '#05070a',
  dim: '#6b6f78',
  dimmer: '#9aa0aa',
  dimText: '#686d76',
  accent: '#1f5a41',
  accentInk: '#ffffff',
  accentSoft: '#e3f2ea',
  accentLine: '#aed8c4',
  accentDim: '#2a6b4f',
  pending: '#9aa0aa',
  pendingSoft: 'rgba(154,160,170,0.18)',
  running: '#3a6fe0',
  runningSoft: '#e6eefb',
  done: '#1e7a4d',
  doneSoft: '#dcefdf',
  // Keep text and glyph contrast safe on every light surface tier.
  failed: '#a92f2f',
  failedSoft: '#f7dcdc',
  skipped: '#7a7e88',
  skippedSoft: 'rgba(122,126,136,0.16)',
  // Keep text safe on every light surface tier. Retain `warningSoft` as a
  // quieter contextual fill.
  warning: '#805504',
  warningSoft: 'rgba(154,108,16,0.14)',
  scrim: 'rgba(17,24,39,0.32)',
  shadow: '0 12px 32px rgba(15,23,42,0.16)',
}

/** Either theme, selectable by name. */
export const THEMES: Record<ThemeName, Theme> = { dark, light }

/**
 * Derive the variant used by the in-app high-contrast setting. Promote
 * de-emphasized text and strengthen borders to meet WCAG 2.2 AA. Preserve
 * status and accent hues to keep state coding legible.
 */
export function highContrastTheme(base: Theme): Theme {
  return {
    ...base,
    text: base.textStrong,
    textSoft: base.textStrong,
    dim: base.text,
    dimmer: base.dim,
    dimText: base.text,
    // Strengthen every border tier to reveal panel edges and dividers.
    borderSoft: base.borderStrong,
    border: base.dim,
    borderStrong: base.text,
    accentLine: base.accent,
  }
}

/**
 * Computer Modern sans for chrome, monospace for data, and serif for reading
 * surfaces and figures. Back each family with bundled WOFF2 files and platform
 * fallbacks.
 */
export const FONTS = {
  sans: "'WebCM Sans 10', 'CMU Sans Serif', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'WebCM Mono 10', 'CMU Typewriter Text', 'Computer Modern Typewriter', ui-monospace, 'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
  serif:
    "'WebCM Serif 10', 'CMU Serif', 'Computer Modern', Georgia, 'Times New Roman', serif",
} as const

/** The name of a density preset, with `compact` as the default. */
export type DensityName = DensityPreference

/**
 * The complete vertical rhythm driven through each density preset. Let shared
 * atoms read these values so one preset change recompresses every screen.
 *
 * Keep the base font at 12 px or larger and interactive targets at 24 px or
 * larger under WCAG 2.2 SC 2.5.8.
 */
export interface Density {
  /** Set the table or list row height in pixels. */
  row: number
  /** Set the base table font size to at least 12 pixels. */
  font: number
  /** Set each square status-cell side to at least 24 pixels. */
  cell: number
  /** Set the gap between status cells in pixels. */
  cellGap: number
  /** Set general container padding in pixels. */
  pad: number
  /** Set the general inline gap in pixels. */
  gap: number
  /** Set the gap between stacked sections or cards in pixels. */
  sectionGap: number
  /** Set card body padding in pixels. */
  cardPad: number
  /** Set card header height in pixels. */
  cardHeader: number
  /** Set page header vertical padding in pixels. */
  headerPadY: number
  /** Set page body vertical padding in pixels. */
  bodyPadY: number
  /** Set dense interactive rows to at least 24 pixels high. */
  rowMinH: number
  /** Set small control height to at least 24 pixels. */
  inputH: number
  /** Set top-bar and navigation-button height in pixels. */
  barH: number
  /** Set bottom run-dock height in pixels. */
  dockH: number
  /** Set vertical divider margin in pixels. */
  dividerMargin: number
  /** Set a tight line height for dense multiline blocks. */
  lineTight: number
}

/**
 * The density presets, with `compact` as the information-dense default.
 * Every preset stays above the WCAG 2.2 font and target-size floors, and
 * `cozy` and `comfortable` add progressively more space.
 */
export const DENSITY: Record<DensityName, Density> = {
  compact: {
    row: 26,
    font: 12,
    cell: 24,
    cellGap: 4,
    pad: 7,
    gap: 7,
    sectionGap: 8,
    cardPad: 7,
    cardHeader: 26,
    headerPadY: 7,
    bodyPadY: 9,
    rowMinH: 24,
    inputH: 26,
    barH: 40,
    dockH: 46,
    dividerMargin: 2,
    lineTight: 1.3,
  },
  cozy: {
    row: 30,
    font: 12.5,
    cell: 26,
    cellGap: 5,
    pad: 9,
    gap: 9,
    sectionGap: 11,
    cardPad: 9,
    cardHeader: 28,
    headerPadY: 9,
    bodyPadY: 12,
    rowMinH: 26,
    inputH: 28,
    barH: 44,
    dockH: 52,
    dividerMargin: 4,
    lineTight: 1.4,
  },
  comfortable: {
    row: 34,
    font: 13,
    cell: 30,
    cellGap: 6,
    pad: 12,
    gap: 12,
    sectionGap: 14,
    cardPad: 12,
    cardHeader: 32,
    headerPadY: 12,
    bodyPadY: 16,
    rowMinH: 30,
    inputH: 30,
    barH: 50,
    dockH: 58,
    dividerMargin: 6,
    lineTight: 1.5,
  },
} as const

/** A readable label for each {@link ChipStatus}. */
export const STATUS_LABEL: Record<ChipStatus, string> = {
  found: 'Found',
  missing: 'Missing',
  wrong: 'Wrong version',
  warn: 'Warning',
  skipped: 'Not checked',
  done: 'Done',
  running: 'Running',
  failed: 'Failed',
  pending: 'Pending',
  queued: 'Queued',
  pass: 'Pass',
  fail: 'Fail',
  review: 'Needs review',
  exclude: 'Exclude',
  unreviewed: 'Unreviewed',
  ok: 'OK',
  na: 'N/A',
  partial: 'Partial',
  planned: 'Planned',
  waiting: 'Waiting',
  blocked: 'Blocked',
  withheld: 'Withheld',
  cancelled: 'Canceled',
  cancelling: 'Canceling',
  interrupted: 'Interrupted',
  stale: 'Stale',
  outdated: 'Out of date',
}

/** Return the foreground color for a status. */
export function statusColor(t: Theme, s: ChipStatus): string {
  switch (s) {
    case 'found':
    case 'done':
    case 'pass':
    case 'ok':
      return t.done
    case 'missing':
    case 'failed':
    case 'fail':
      return t.failed
    case 'wrong':
    case 'warn':
    case 'review':
    case 'partial':
    case 'blocked':
    case 'withheld':
    case 'interrupted':
    case 'stale':
    case 'outdated':
      return t.warning
    case 'running':
    case 'queued':
    case 'planned':
    case 'waiting':
    case 'cancelling':
      // Use the dedicated blue for in-progress states. Keep it distinct from
      // green completion and amber review states.
      return t.running
    case 'skipped':
    case 'pending':
    case 'unreviewed':
    case 'na':
    case 'cancelled':
      // Use a quiet neutral for pending decoration. Keep dots and lines
      // understated but perceivable on the pending tint.
      return t.dim
    case 'exclude':
      return t.skipped
    default:
      return t.dim
  }
}

/** Return the soft background color for a status. */
export function statusSoft(t: Theme, s: ChipStatus): string {
  switch (s) {
    case 'found':
    case 'done':
    case 'pass':
    case 'ok':
      return t.doneSoft
    case 'missing':
    case 'failed':
    case 'fail':
      return t.failedSoft
    case 'wrong':
    case 'warn':
    case 'review':
    case 'partial':
    case 'blocked':
    case 'withheld':
    case 'interrupted':
    case 'stale':
    case 'outdated':
      return t.warningSoft
    case 'running':
    case 'queued':
    case 'planned':
    case 'waiting':
    case 'cancelling':
      return t.runningSoft
    case 'skipped':
    case 'pending':
    case 'unreviewed':
    case 'na':
    case 'cancelled':
      return t.pendingSoft
    case 'exclude':
      return t.skippedSoft
    default:
      return t.surface2
  }
}
