/**
 * Export the Brain tab's view as a figure: render it again on the print
 * paper (slices on black) at the export's resolution, crop it to the brain,
 * and rasterize it with the color scale and caption, like the other
 * exported figures. The scale and text are drawn as vectors, so the PNG
 * carries the embedded serif and its physical size.
 */

import { createElement } from 'react'
import type { Rgb } from './brain-map'
import { BrainFigure } from './brain-figure'
import {
  brainFigureLayout,
  type BrainFigureScale,
  type PixelBox,
} from './brain-figure-layout'
import { pngPixelSize, rasterizeSvg } from '../../../figures/png-export'
import type { Rich } from '../../../figures/rich'
import { PRINT_PALETTE, mmToPt } from '../../../figures/style'
import { figureSvg } from '../../../figures/svg-export'

/**
 * Find the box of the pixels that differ from the background, with a
 * margin of 3% of its longer side, inside the image.
 *
 * @param width - The width in pixels.
 * @param height - The height in pixels.
 * @param background - The background, 0-255 RGB.
 * @returns The box, or null when every pixel is background.
 */
export function contentBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  background: Rgb,
): PixelBox | null {
  let left = width
  let right = -1
  let top = height
  let bottom = -1
  const [r, g, b] = background
  for (let y = 0, at = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, at += 4) {
      if (
        Math.abs(data[at]! - r) > 8 ||
        Math.abs(data[at + 1]! - g) > 8 ||
        Math.abs(data[at + 2]! - b) > 8
      ) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        bottom = y
      }
    }
  }
  if (right < 0) return null
  const margin = Math.round(0.03 * Math.max(right - left + 1, bottom - top + 1))
  const x = Math.max(0, left - margin)
  const y = Math.max(0, top - margin)
  return {
    x,
    y,
    width: Math.min(width, right + margin + 1) - x,
    height: Math.min(height, bottom + margin + 1) - y,
  }
}

/** The largest render multiplier an export asks for. */
export const MAX_RENDER_SCALE = 12

/**
 * Choose the render multiplier that draws the brain at the export's pixel
 * width: never below the screen's resolution, never above the cap.
 *
 * @param contentPx - The brain's width in the screen render, in pixels.
 * @param targetPx - The width it takes in the exported PNG, in pixels.
 */
export function renderScale(contentPx: number, targetPx: number): number {
  if (!(contentPx > 0)) return 1
  return Math.min(MAX_RENDER_SCALE, Math.max(1, targetPx / contentPx))
}

/** What an exported brain figure shows besides the render. */
export interface BrainFigureRequest {
  /** The render background, 0-1 RGB: the print paper or the slice black. */
  background: readonly [number, number, number]
  widthMm: number
  dpi: number
  lines: readonly Rich[]
  scale: BrainFigureScale
  title: string
  summary: string
  /**
   * Render this many times the export's resolution and scale down, so a
   * volume render's sampling grain averages out (the cut view); 1 when
   * omitted.
   */
  supersample?: number
}

/** One export render: the frame and, for Slices, its panes. */
export interface ExportFrame {
  canvas: HTMLCanvasElement
  tiles: PixelBox[] | null
}

/** One export render request, as the viewer takes it. */
export interface ExportFrameRequest {
  scale: number
  aspect?: number | null
}

/** The gap between slice panes in a composed figure, as a share of a pane. */
const TILE_GAP = 0.04
/** The widest a render's canvas is shaped for an export. */
const MAX_ASPECT = 4

function readPixels(frame: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = frame.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('The brain view could not be read.')
  return context
}

/**
 * The part of a frame the figure keeps: the content box, or for slice
 * panes one box (the union of each pane's content, relative to its pane)
 * that every pane is cut to.
 */
function keptBoxes(
  frame: ExportFrame,
  background: Rgb,
): { boxes: PixelBox[]; context: CanvasRenderingContext2D } {
  const context = readPixels(frame.canvas)
  const { width, height } = frame.canvas
  const pixels = context.getImageData(0, 0, width, height)
  const tiles = (frame.tiles ?? []).filter(
    (tile) =>
      tile.width > 0 &&
      tile.height > 0 &&
      tile.x + tile.width <= width &&
      tile.y + tile.height <= height,
  )
  if (tiles.length < 2) {
    const box = contentBounds(pixels.data, width, height, background) ?? {
      x: 0,
      y: 0,
      width,
      height,
    }
    return { boxes: [box], context }
  }
  let union: {
    left: number
    top: number
    right: number
    bottom: number
  } | null = null
  for (const tile of tiles) {
    const data = context.getImageData(tile.x, tile.y, tile.width, tile.height)
    const box = contentBounds(data.data, tile.width, tile.height, background)
    if (!box) continue
    union = union
      ? {
          left: Math.min(union.left, box.x),
          top: Math.min(union.top, box.y),
          right: Math.max(union.right, box.x + box.width),
          bottom: Math.max(union.bottom, box.y + box.height),
        }
      : {
          left: box.x,
          top: box.y,
          right: box.x + box.width,
          bottom: box.y + box.height,
        }
  }
  const inner = union ?? {
    left: 0,
    top: 0,
    right: Math.min(...tiles.map((t) => t.width)),
    bottom: Math.min(...tiles.map((t) => t.height)),
  }
  return {
    boxes: tiles.map((tile) => ({
      x: tile.x + inner.left,
      y: tile.y + inner.top,
      width: Math.min(inner.right, tile.width) - inner.left,
      height: Math.min(inner.bottom, tile.height) - inner.top,
    })),
    context,
  }
}

/** The width and height the kept boxes compose to, side by side. */
function composedSize(boxes: readonly PixelBox[]): {
  width: number
  height: number
  gap: number
} {
  const gap =
    boxes.length > 1
      ? Math.round(TILE_GAP * Math.max(...boxes.map((b) => b.width)))
      : 0
  return {
    width:
      boxes.reduce((sum, box) => sum + box.width, 0) + gap * (boxes.length - 1),
    height: Math.max(...boxes.map((box) => box.height)),
    gap,
  }
}

/**
 * Cut the kept boxes out of a frame and set them side by side on the print
 * paper, scaled down to at most `maxWidth` pixels with smoothing.
 */
function compose(
  frame: ExportFrame,
  background: Rgb,
  maxWidth: number,
): HTMLCanvasElement {
  const { boxes, context } = keptBoxes(frame, background)
  const size = composedSize(boxes)
  const out = document.createElement('canvas')
  out.width = size.width
  out.height = size.height
  const outContext = out.getContext('2d')
  if (!outContext) throw new Error('The brain view could not be read.')
  if (boxes.length > 1) {
    outContext.fillStyle = PRINT_PALETTE.paper
    outContext.fillRect(0, 0, size.width, size.height)
  }
  let x = 0
  for (const box of boxes) {
    outContext.putImageData(
      context.getImageData(box.x, box.y, box.width, box.height),
      x,
      0,
    )
    x += box.width + size.gap
  }
  const factor = maxWidth > 0 ? out.width / maxWidth : 1
  if (factor <= 1.2) return out
  const small = document.createElement('canvas')
  small.width = Math.max(1, Math.round(out.width / factor))
  small.height = Math.max(1, Math.round(out.height / factor))
  const smallContext = small.getContext('2d')
  if (!smallContext) return out
  smallContext.imageSmoothingEnabled = true
  smallContext.imageSmoothingQuality = 'high'
  smallContext.drawImage(out, 0, 0, small.width, small.height)
  return small
}

/**
 * Render and compose the exported brain figure as PNG.
 *
 * The first render, at the screen's resolution, measures the brain; the
 * canvas is then shaped like it (one pane per slice plane, side by side),
 * and the last render draws it at its width in the PNG (times the
 * supersampling), with slice panes cut to the brain and set apart on the
 * print paper.
 *
 * @param renderFrames - Open one export render of the view on the request's
 *   background and run `draw` with a function that draws a frame and returns a
 *   2D canvas copy with its slice panes.
 * @param request - The export's width, resolution, and text.
 * @returns The PNG bytes, with the resolution recorded.
 */
export async function brainFigurePng(
  renderFrames: (
    draw: (
      renderFrame: (request: ExportFrameRequest) => ExportFrame,
    ) => HTMLCanvasElement,
  ) => HTMLCanvasElement,
  request: BrainFigureRequest,
): Promise<Uint8Array> {
  const background = request.background.map((c) =>
    Math.round(c * 255),
  ) as unknown as Rgb
  const width = mmToPt(request.widthMm)
  const supersample = Math.max(1, request.supersample ?? 1)
  const crop = renderFrames((renderFrame) => {
    const first = renderFrame({ scale: 1 })
    const firstBoxes = keptBoxes(first, background).boxes
    const firstSize = composedSize(firstBoxes)
    const aspect =
      firstBoxes.length > 1
        ? (first.tiles ?? []).reduce((sum, tile) => sum + tile.width, 0) /
          Math.max(1, ...(first.tiles ?? []).map((tile) => tile.height))
        : firstSize.width / Math.max(1, firstSize.height)
    const shapedAspect = Math.max(1, Math.min(MAX_ASPECT, aspect))
    const shaped = renderFrame({ scale: 1, aspect: shapedAspect })
    const size = composedSize(keptBoxes(shaped, background).boxes)
    const layout = brainFigureLayout(width, size, request.lines, request.scale)
    const targetPx = (layout.image.w / 72) * request.dpi
    const multiplier = renderScale(size.width, targetPx * supersample)
    const final =
      multiplier > 1.05
        ? renderFrame({ scale: multiplier, aspect: shapedAspect })
        : shaped
    return compose(final, background, targetPx)
  })
  const image = {
    href: crop.toDataURL('image/png'),
    width: crop.width,
    height: crop.height,
  }
  const layout = brainFigureLayout(width, image, request.lines, request.scale)
  const svg = await figureSvg(
    createElement(BrainFigure, {
      image,
      width,
      widthMm: request.widthMm,
      lines: request.lines,
      scale: request.scale,
      title: request.title,
      summary: request.summary,
    }),
  )
  const heightMm = (layout.height / width) * request.widthMm
  return rasterizeSvg(
    svg,
    pngPixelSize(request.widthMm, heightMm, request.dpi),
    request.dpi,
  )
}
