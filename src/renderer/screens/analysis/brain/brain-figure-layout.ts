/**
 * The page layout of the exported brain figure, in points. Every text line
 * fits the figure's inner width: caption lines wrap at word boundaries, and
 * the color scale moves its end labels onto a second row when one row would
 * not fit, so an 85 mm export clips nothing.
 */

import type { Rich, RichRun } from '../../../figures/rich'
import { richWidth } from '../../../figures/rich'
import { FIGURE_FONT_PT, fitText, textWidth } from '../../../figures/style'
import { formatStat } from './brain-map'

/** A pixel box. */
export interface PixelBox {
  x: number
  y: number
  width: number
  height: number
}

/** The color scale of an exported brain figure. */
export interface BrainFigureScale {
  stat: 'd' | 't'
  limit: number
  negative: string
  positive: string
}

/** The figure's inner margin. */
export const PAD = 4
/** The caption line height. */
export const LINE = FIGURE_FONT_PT * 1.35
/** The color bar's width. */
export const BAR_WIDTH = 64
/** The color bar's height. */
export const BAR_HEIGHT = FIGURE_FONT_PT * 0.9
/** The tallest a render may draw, as a share of the figure width. */
const MAX_IMAGE_ASPECT = 0.8
/** The gap between the parts of a scale row. */
const GAP = FIGURE_FONT_PT * 0.6
/** The key's swatch width. */
export const SWATCH = FIGURE_FONT_PT * 1.4

/** One text placed on the figure. */
export interface PlacedText {
  text: string
  x: number
  y: number
  anchor: 'start' | 'end'
}

/** Where everything of an exported brain figure goes. */
export interface BrainFigureLayout {
  /** The caption lines after wrapping, with their baselines. */
  lines: { rich: Rich; y: number }[]
  /** The render's box. */
  image: { x: number; y: number; w: number; h: number }
  bar: { x: number; y: number }
  /** The scale's texts: its end values and its end labels. */
  texts: PlacedText[]
  /** The statistic's symbol, set in parentheses after the scale. */
  stat: { x: number; y: number }
  /** The key's two swatches, significant first, with their labels. */
  key: { x: number; y: number; label: string }[]
  height: number
}

type Style = 'plain' | 'i' | 'b'

function runText(run: RichRun): [Style, string] {
  return typeof run === 'string'
    ? ['plain', run]
    : 'i' in run
      ? ['i', run.i]
      : ['b', run.b]
}

function toRich(tokens: readonly [Style, string][]): Rich {
  const out: RichRun[] = []
  let style: Style | null = null
  let text = ''
  const flush = (): void => {
    if (style === null || text === '') return
    out.push(
      style === 'plain' ? text : style === 'i' ? { i: text } : { b: text },
    )
  }
  for (const [next, word] of tokens) {
    if (next !== style) {
      flush()
      style = next
      text = ''
    }
    text += word
  }
  flush()
  return out
}

/**
 * Wrap a rich line at spaces to a width, keeping each run's style. A word
 * longer than the width is shortened with an ellipsis.
 *
 * @param size - The type size in points.
 * @param width - The width in points.
 * @returns One or more lines, each within the width.
 */
export function wrapRich(line: Rich, size: number, width: number): Rich[] {
  const tokens: [Style, string][] = []
  for (const run of line) {
    const [style, text] = runText(run)
    for (const word of text.split(/(?<= )/)) tokens.push([style, word])
  }
  const lines: [Style, string][][] = [[]]
  const trimmed = (list: [Style, string][]): Rich => {
    const copy = list.map(([s, t]) => [s, t] as [Style, string])
    const last = copy.at(-1)
    if (last) last[1] = last[1].trimEnd()
    return toRich(copy)
  }
  for (const token of tokens) {
    const current = lines.at(-1)!
    if (
      current.length > 0 &&
      richWidth(trimmed([...current, token]), size) > width
    ) {
      lines.push([token])
    } else {
      current.push(token)
    }
  }
  return lines.map((list) => {
    const rich = trimmed(list)
    return richWidth(rich, size) > width
      ? [fitText(rich.map((r) => runText(r)[1]).join(''), size, width)]
      : rich
  })
}

/**
 * Lay out a brain figure: the wrapped caption, the render (the full inner
 * width, or narrower and centered when that would make it taller than the
 * aspect cap), the color scale, and the key.
 *
 * @param width - The figure width in points.
 */
export function brainFigureLayout(
  width: number,
  image: { width: number; height: number },
  lines: readonly Rich[],
  scale: BrainFigureScale,
): BrainFigureLayout {
  const fs = FIGURE_FONT_PT
  const inner = width - 2 * PAD
  const wrapped = lines.flatMap((line) => wrapRich(line, fs, inner))
  const placedLines = wrapped.map((rich, index) => ({
    rich,
    y: PAD + LINE * (index + 1) - fs * 0.3,
  }))
  const aspect = image.height / Math.max(1, image.width)
  const h = Math.min(inner * aspect, width * MAX_IMAGE_ASPECT)
  const w = h / aspect
  const imageY = PAD + wrapped.length * LINE + fs * 0.5
  const box = { x: (width - w) / 2, y: imageY, w, h }

  const low = formatStat(-scale.limit)
  const high = formatStat(scale.limit)
  const statText = `(${scale.stat})`
  const negW = textWidth(scale.negative, fs)
  const posW = textWidth(scale.positive, fs)
  const lowW = textWidth(low, fs)
  const highW = textWidth(high, fs)
  const statW = textWidth(statText, fs)
  const barY = imageY + h + fs * 1.2
  const textY = barY + BAR_HEIGHT / 2 + fs * 0.35
  const texts: PlacedText[] = []
  let bar: { x: number; y: number }
  let stat: { x: number; y: number }
  let bottom = barY + BAR_HEIGHT
  const oneRow = negW + lowW + BAR_WIDTH + highW + posW + statW + GAP * 5
  if (oneRow <= inner) {
    let x = (width - oneRow) / 2
    texts.push({ text: scale.negative, x, y: textY, anchor: 'start' })
    x += negW + GAP
    texts.push({ text: low, x, y: textY, anchor: 'start' })
    x += lowW + GAP
    bar = { x, y: barY }
    x += BAR_WIDTH + GAP
    texts.push({ text: high, x, y: textY, anchor: 'start' })
    x += highW + GAP
    texts.push({ text: scale.positive, x, y: textY, anchor: 'start' })
    x += posW + GAP
    stat = { x, y: textY }
  } else {
    // Values and bar on one row; the end labels under its two ends.
    const row = lowW + BAR_WIDTH + highW + statW + GAP * 3
    let x = (width - row) / 2
    texts.push({ text: low, x, y: textY, anchor: 'start' })
    x += lowW + GAP
    bar = { x, y: barY }
    x += BAR_WIDTH + GAP
    texts.push({ text: high, x, y: textY, anchor: 'start' })
    x += highW + GAP
    stat = { x, y: textY }
    const span = Math.min(inner, Math.max(row, negW + posW + GAP * 2))
    const start = (width - span) / 2
    const negMax = Math.max((span - GAP) / 2, span - GAP - posW)
    const negative = fitText(scale.negative, fs, negMax)
    const posMax = span - GAP - textWidth(negative, fs)
    const labelY = textY + fs * 1.3
    texts.push({ text: negative, x: start, y: labelY, anchor: 'start' })
    texts.push({
      text: fitText(scale.positive, fs, posMax),
      x: start + span,
      y: labelY,
      anchor: 'end',
    })
    bottom = labelY + fs * 0.3
  }
  const keyY = bottom + fs * 1.3
  const labels = ['Significant', 'Not significant']
  const parts = labels.map((label) => SWATCH + fs * 0.4 + textWidth(label, fs))
  let keyX = (width - parts[0]! - parts[1]! - fs * 1.6) / 2
  const key = labels.map((label, index) => {
    const placed = { x: keyX, y: keyY, label }
    keyX += parts[index]! + fs * 1.6
    return placed
  })
  const height = Math.ceil(keyY + fs * 0.4 + PAD)
  return { lines: placedLines, image: box, bar, texts, stat, key, height }
}
