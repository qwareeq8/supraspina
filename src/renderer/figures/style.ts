/**
 * The figure style shared by the Analysis previews and exports. An export
 * draws in black ink on white paper, as a printed figure does; an on-screen
 * preview draws in the app theme's ink on its surface, so a figure never
 * shows a white page inside the dark theme. The series colors are
 * Okabe-Ito, which stays distinct under the common color-vision
 * deficiencies. Every length is in points (1/72 inch): an exported figure
 * maps one viewBox unit to one point, so 7 pt text prints at 7 pt.
 */

import { FONTS, type Theme, type ThemeName } from '../theme/tokens'

/** The Okabe-Ito colors the figures use. */
export const OKABE_ITO = {
  blue: '#0072B2',
  vermillion: '#D55E00',
  bluishGreen: '#009E73',
  reddishPurple: '#CC79A7',
  orange: '#E69F00',
  skyBlue: '#56B4E9',
} as const

/** The figure palette: the reference group, the focal group, then the others. */
export const FIGURE_COLORS = {
  reference: OKABE_ITO.blue,
  focal: OKABE_ITO.vermillion,
  others: [OKABE_ITO.bluishGreen, OKABE_ITO.reddishPurple, OKABE_ITO.orange],
  ink: '#111111',
  muted: '#555555',
  rule: '#777777',
  paper: '#ffffff',
} as const

/** The colors one drawing of a figure uses. */
export interface FigurePalette {
  paper: string
  ink: string
  muted: string
  rule: string
  /** The band behind the selected forest row; drawn on screen only. */
  selection: string
  /** The PROVISIONAL badge. */
  provisional: string
  /** The drawn color of a model's series color, which is a print color. */
  series: (color: string) => string
}

/** The print palette every export draws with. */
export const PRINT_PALETTE: FigurePalette = {
  paper: FIGURE_COLORS.paper,
  ink: FIGURE_COLORS.ink,
  muted: FIGURE_COLORS.muted,
  rule: FIGURE_COLORS.rule,
  selection: 'transparent',
  provisional: FIGURE_COLORS.focal,
  series: (color) => color,
}

/**
 * The light theme's stand-ins for the two Okabe-Ito colors under 3:1 on its
 * white surface (orange 2.3:1, reddish purple 3.1:1): the same hues, darker,
 * at 3.7:1 and 4.2:1. Every other series color already clears 3:1 on both
 * themes' surfaces (Okabe-Ito blue is the lowest, 3.5:1 on the dark one).
 */
const LIGHT_SCREEN_SERIES: Readonly<Record<string, string>> = {
  [OKABE_ITO.orange]: '#B37A00',
  [OKABE_ITO.reddishPurple]: '#B3628F',
}

/**
 * Give the on-screen palette of a theme: its surface as the paper, its text
 * tokens as the ink, and the series colors that hold 3:1 on that surface.
 */
export function screenPalette(t: Theme, name: ThemeName): FigurePalette {
  return {
    paper: t.surface,
    ink: t.text,
    muted: t.dimText,
    rule: t.dim,
    selection: t.accentSoft,
    provisional: t.warning,
    series:
      name === 'light'
        ? (color) => LIGHT_SCREEN_SERIES[color] ?? color
        : (color) => color,
  }
}

/** The export widths in millimeters: single, one-and-a-half, and double column. */
export const FIGURE_WIDTHS_MM = [85, 114, 174] as const
/** One export width. */
export type FigureWidthMm = (typeof FIGURE_WIDTHS_MM)[number]
/** The PNG resolutions offered, in dots per inch. */
export const FIGURE_DPIS = [300, 600] as const
/** One PNG resolution. */
export type FigureDpi = (typeof FIGURE_DPIS)[number]

/** Points per millimeter. */
export const PT_PER_MM = 72 / 25.4

/** Convert a width in millimeters to points. */
export function mmToPt(mm: number): number {
  return mm * PT_PER_MM
}

/** The base type size in points, at physical size. */
export const FIGURE_FONT_PT = 7
/** Screen pixels per figure point in the on-screen previews. */
export const SCREEN_PX_PER_PT = 1.6

/** The family name the exported SVG embeds the serif under. */
export const EMBEDDED_SERIF = 'SupraspinaFigureSerif'

/** How a figure is being drawn. */
export type FigureMode = 'screen' | 'export'

/**
 * Give the font stack of a figure: the app's bundled Computer Modern serif on
 * screen, and the embedded copy first in an export.
 */
export function figureFont(mode: FigureMode): string {
  return mode === 'export' ? `'${EMBEDDED_SERIF}', ${FONTS.serif}` : FONTS.serif
}

let measurer: CanvasRenderingContext2D | null | undefined

/** A canvas context for measuring, or null where none exists (tests). */
function measureContext(): CanvasRenderingContext2D | null {
  if (measurer !== undefined) return measurer
  measurer = null
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) {
    return measurer
  }
  try {
    measurer = document.createElement('canvas').getContext('2d')
  } catch {
    measurer = null
  }
  return measurer
}

/**
 * Estimate a text's advance width from Computer Modern's proportions, where
 * no canvas can measure it: lowercase about half an em, digits exactly half
 * an em, the minus sign wider.
 *
 * @param size - The type size in points.
 * @returns The estimated width in points.
 */
function estimateTextWidth(text: string, size: number): number {
  let em = 0
  for (const ch of text) {
    if (/[il.,:;'|!]/.test(ch)) em += 0.28
    else if (/[fjrt()[\]]/.test(ch)) em += 0.39
    else if (/[mwMW\u2212+=<>\u2264\u2190]/.test(ch)) em += 0.8
    else if (/[A-Z]/.test(ch)) em += 0.72
    else if (ch === ' ') em += 0.33
    else em += 0.5
  }
  return em * size
}

/**
 * Measure a text's advance width in the figure serif, in the units of
 * `size`: with the loaded font on a canvas when possible, else estimated.
 *
 * @param size - The type size in points.
 * @returns The width in points.
 */
export function textWidth(text: string, size: number): number {
  const context = measureContext()
  const font = `${size * 4}px 'WebCM Serif 10'`
  if (context && document.fonts?.check?.(font)) {
    context.font = font
    return context.measureText(text).width / 4
  }
  return estimateTextWidth(text, size)
}

/**
 * Shorten text with an ellipsis to fit a width.
 *
 * @param size - The type size in points.
 * @param width - The available width in points.
 * @returns The text, shortened when needed.
 */
export function fitText(text: string, size: number, width: number): string {
  if (textWidth(text, size) <= width) return text
  let out = text
  while (out.length > 1 && textWidth(`${out}\u2026`, size) > width) {
    out = out.slice(0, -1)
  }
  return `${out.trimEnd()}\u2026`
}

/** The marker shapes, in the order source labels take them. */
export const MARKER_SHAPES = [
  'circle',
  'triangle',
  'square-open',
  'diamond',
  'circle-open',
  'triangle-open',
] as const
/** One marker shape. */
export type MarkerShape = (typeof MARKER_SHAPES)[number]
