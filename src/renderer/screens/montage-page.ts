/**
 * Display the ENIGMA QC montage panels on the theme surface instead of the
 * white figure page MATLAB saves them on. The transform is display-only: the
 * file on disk and its verification stay untouched. Only pure white pixels
 * (exactly 255, 255, 255, opaque) that connect to the image border through
 * other such pixels, outside the image axes, become transparent, and the
 * fully transparent margins are then trimmed. Every other pixel keeps its
 * value, so the brain, the overlays, the white Left and Right boxes, and the
 * red subject tag stay exactly as drawn. A surface render on black has no
 * white border and comes back unchanged.
 */

import { useEffect, useState } from 'react'

/** A pixel box. */
export interface KeptBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What keying one image did. */
export interface PageKey {
  /** The number of pixels made transparent. */
  removed: number
  /** The box of the remaining pixels, or null when none remain. */
  bounds: KeptBounds | null
}

/**
 * Find the image axes: the rows, and the columns, that are mostly not pure
 * white. MATLAB fills the axes with the slice, so its rows and columns are
 * nearly all drawn, while the page, and the subject tag that hangs below the
 * axes, are nearly all white. The keying never enters this box: in the scaled
 * gallery panels a Left or Right box meets the axes edge, so its white
 * touches the page's.
 *
 * @param white - Whether each pixel is pure white.
 * @param width - The width in pixels.
 * @param height - The height in pixels.
 * @returns The axes box, or null for an all-white image.
 */
export function axesBox(
  white: Uint8Array,
  width: number,
  height: number,
): KeptBounds | null {
  const rows = new Int32Array(height)
  const columns = new Int32Array(width)
  for (let y = 0, index = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, index += 1) {
      if (white[index] === 0) {
        rows[y]! += 1
        columns[x]! += 1
      }
    }
  }
  const span = (counts: Int32Array): [number, number] | null => {
    const limit = Math.max(...counts) / 2
    if (limit === 0) return null
    let first = -1
    let last = -1
    counts.forEach((n, i) => {
      if (n > limit) {
        if (first < 0) first = i
        last = i
      }
    })
    return [first, last]
  }
  const ys = span(rows)
  const xs = span(columns)
  if (!ys || !xs) return null
  return {
    x: xs[0],
    y: ys[0],
    width: xs[1] - xs[0] + 1,
    height: ys[1] - ys[0] + 1,
  }
}

/**
 * Make the pure white pixels 4-connected to the border outside the image
 * axes transparent, in place.
 *
 * @param data - Non-premultiplied RGBA rows, as `ImageData.data` holds them.
 * @param width - The width in pixels.
 * @param height - The height in pixels.
 * @returns How many pixels became transparent, and the kept box.
 */
export function keyBorderWhite(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): PageKey {
  const count = width * height
  const white = new Uint8Array(count)
  // Read each pixel as one little-endian word: 0xffffffff is opaque white.
  const words = new Uint32Array(data.buffer, data.byteOffset, count)
  for (let index = 0; index < count; index += 1) {
    white[index] = words[index] === 0xffffffff ? 1 : 0
  }
  // Clear the flags inside the axes, so the flood never enters it.
  const axes = axesBox(white, width, height)
  if (axes) {
    for (let y = axes.y; y < axes.y + axes.height; y += 1) {
      white.fill(0, y * width + axes.x, y * width + axes.x + axes.width)
    }
  }
  const stack = new Int32Array(count)
  let top = 0
  const push = (index: number): void => {
    if (white[index] === 1) {
      // Clear a queued pixel's flag to mark it visited.
      white[index] = 0
      stack[top++] = index
    }
  }
  for (let x = 0; x < width; x += 1) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width)
    push(y * width + width - 1)
  }
  let removed = 0
  while (top > 0) {
    const index = stack[--top]!
    const at = index * 4
    data[at] = 0
    data[at + 1] = 0
    data[at + 2] = 0
    data[at + 3] = 0
    removed += 1
    const x = index % width
    if (x > 0) push(index - 1)
    if (x < width - 1) push(index + 1)
    if (index >= width) push(index - width)
    if (index < count - width) push(index + width)
  }
  let left = width
  let right = -1
  let upper = height
  let lower = -1
  for (let y = 0, at = 3; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, at += 4) {
      if (data[at] !== 0) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < upper) upper = y
        lower = y
      }
    }
  }
  return {
    removed,
    bounds:
      right < 0
        ? null
        : {
            x: left,
            y: upper,
            width: right - left + 1,
            height: lower - upper + 1,
          },
  }
}

/** Whether this renderer can key images: Chromium can, jsdom cannot. */
function canKey(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined' &&
    typeof Image !== 'undefined' &&
    typeof document !== 'undefined'
  )
}

/**
 * Key one image data URL. Decoding runs off the main thread; the flood fill
 * and the PNG encoding of a 544 x 408 panel take a few milliseconds on it.
 *
 * Encode with the synchronous `toDataURL`. `convertToBlob` and `toBlob`
 * encode in a renderer idle period and wait up to a second for one; a
 * renderer that is drawing QC review grants none, so every panel would wait
 * that second.
 *
 * @returns A PNG data URL of the keyed and trimmed image, or the input when
 *   nothing was keyed.
 */
async function keyImage(dataUrl: string): Promise<string> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  // Read the stored values: no color-space conversion and no premultiplying.
  const bitmap = await createImageBitmap(image, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  const { width, height } = bitmap
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return dataUrl
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const pixels = context.getImageData(0, 0, width, height)
  const { removed, bounds } = keyBorderWhite(pixels.data, width, height)
  if (removed === 0 || bounds === null) return dataUrl
  const out = document.createElement('canvas')
  out.width = bounds.width
  out.height = bounds.height
  const outContext = out.getContext('2d')
  if (!outContext) return dataUrl
  outContext.putImageData(pixels, -bounds.x, -bounds.y)
  return out.toDataURL('image/png')
}

/** The most keyed images kept; a subject's three galleries hold about 60. */
const CACHE_LIMIT = 96
const keyed = new Map<string, string>()

/** A queued or running keying of one image and who waits for it. */
interface Job {
  source: string
  priority: number
  /** The request order, which breaks priority ties first come, first served. */
  order: number
  listeners: Set<(shown: string) => void>
}

const queued = new Map<string, Job>()
let active: Job | null = null
let requests = 0

function remember(source: string, result: string): void {
  keyed.delete(source)
  keyed.set(source, result)
  while (keyed.size > CACHE_LIMIT) {
    keyed.delete(keyed.keys().next().value!)
  }
}

/** Start the next job: the highest priority, then the earliest request. */
function pump(): void {
  if (active) return
  let next: Job | null = null
  for (const job of queued.values()) {
    if (
      !next ||
      job.priority > next.priority ||
      (job.priority === next.priority && job.order < next.order)
    ) {
      next = job
    }
  }
  if (!next) return
  const job = next
  queued.delete(job.source)
  active = job
  void new Promise((resolve) => setTimeout(resolve, 0))
    .then(() => keyImage(job.source))
    .catch(() => job.source)
    .then((result) => {
      remember(job.source, result)
      active = null
      for (const listener of job.listeners) listener(result)
      pump()
    })
}

/**
 * Ask for an image keyed, once per data URL. Images key one at a time, each
 * in its own task, so a gallery of panels never holds the main thread for
 * long; a higher priority goes first, as the enlarged view does. Releasing a
 * request that has not started drops it, so the panels of a subject left
 * behind do not delay the next one. An image that cannot be keyed shows as
 * stored.
 *
 * @param priority - Higher goes first.
 * @param onReady - Called with the keyed image's data URL.
 * @returns A function that releases the request.
 */
export function requestKeyedPage(
  dataUrl: string,
  priority: number,
  onReady: (shown: string) => void,
): () => void {
  const done = keyed.get(dataUrl) ?? (canKey() ? undefined : dataUrl)
  if (done !== undefined) {
    let live = true
    void Promise.resolve().then(() => {
      if (live) onReady(done)
    })
    return () => {
      live = false
    }
  }
  let job = active?.source === dataUrl ? active : queued.get(dataUrl)
  if (!job) {
    job = { source: dataUrl, priority, order: requests, listeners: new Set() }
    queued.set(dataUrl, job)
  }
  requests += 1
  job.priority = Math.max(job.priority, priority)
  const listener = (shown: string): void => onReady(shown)
  job.listeners.add(listener)
  const owner = job
  pump()
  return () => {
    owner.listeners.delete(listener)
    if (owner.listeners.size === 0 && queued.get(dataUrl) === owner) {
      queued.delete(dataUrl)
    }
  }
}

/** Key an image once per data URL, at the lowest priority. */
export function keyedPage(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    requestKeyedPage(dataUrl, 0, resolve)
  })
}

/**
 * Give the keyed form of a montage panel for display. Unmounting, or moving
 * to another image, releases the request.
 *
 * @param dataUrl - The stored image as a data URL, or null.
 * @param priority - Higher goes first; the enlarged view passes 1.
 * @returns The keyed data URL, or null until it is ready.
 */
export function useKeyedPage(
  dataUrl: string | null,
  priority = 0,
): string | null {
  const immediate =
    dataUrl === null
      ? null
      : (keyed.get(dataUrl) ?? (canKey() ? null : dataUrl))
  const [state, setState] = useState<{ source: string; shown: string } | null>(
    null,
  )
  useEffect(() => {
    if (dataUrl === null || immediate !== null) return undefined
    return requestKeyedPage(dataUrl, priority, (shown) =>
      setState({ source: dataUrl, shown }),
    )
  }, [dataUrl, immediate, priority])
  if (immediate !== null) return immediate
  return state !== null && state.source === dataUrl ? state.shown : null
}
