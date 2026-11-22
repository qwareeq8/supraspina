/**
 * Rasterize an exported SVG figure to PNG at 300 or 600 dpi, and record the
 * resolution in the PNG's pHYs chunk so layout programs place it at its
 * physical size. The SVG loads as a data URL, which the renderer's CSP allows
 * for images; the embedded font travels inside it.
 */

/** Pixel size of a figure. */
export interface PixelSize {
  width: number
  height: number
}

/**
 * Give the pixel size of a figure at a resolution.
 *
 * @param widthMm - The physical width in millimeters.
 * @param heightMm - The physical height in millimeters.
 * @param dpi - The resolution in dots per inch.
 * @returns Whole pixels, rounded to nearest.
 */
export function pngPixelSize(
  widthMm: number,
  heightMm: number,
  dpi: number,
): PixelSize {
  return {
    width: Math.round((widthMm / 25.4) * dpi),
    height: Math.round((heightMm / 25.4) * dpi),
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * Compute the CRC-32 a PNG chunk carries.
 *
 * @param bytes - The chunk type and data.
 * @returns The unsigned CRC.
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/**
 * Set a PNG's resolution: insert (or replace) a pHYs chunk after IHDR with
 * the resolution in pixels per meter.
 *
 * @param dpi - The resolution in dots per inch.
 * @returns New PNG bytes.
 * @throws TypeError when the bytes are not a PNG.
 */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (!PNG_SIGNATURE.every((byte, index) => png[index] === byte)) {
    throw new TypeError('Provide PNG bytes.')
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks: Uint8Array[] = [png.subarray(0, 8)]
  let offset = 8
  let inserted = false
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    const end = offset + 12 + length
    if (type !== 'pHYs') chunks.push(png.subarray(offset, end))
    if (type === 'IHDR' && !inserted) {
      chunks.push(physChunk(dpi))
      inserted = true
    }
    offset = end
  }
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function physChunk(dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254)
  const chunk = new Uint8Array(21)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, 9)
  chunk.set([0x70, 0x48, 0x59, 0x73], 4)
  view.setUint32(8, ppm)
  view.setUint32(12, ppm)
  chunk[16] = 1
  view.setUint32(17, crc32(chunk.subarray(4, 17)))
  return chunk
}

/**
 * Read a PNG's pixel size and pHYs resolution.
 *
 * @returns The size and the dots per inch, or null dpi without pHYs.
 */
export function readPngInfo(
  png: Uint8Array,
): PixelSize & { dpi: number | null } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let dpi: number | null = null
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    if (type === 'pHYs' && png[offset + 16] === 1) {
      dpi = Math.round(view.getUint32(offset + 8) * 0.0254)
    }
    offset += 12 + length
  }
  return { width: view.getUint32(16), height: view.getUint32(20), dpi }
}

/** Base64-encode UTF-8 text for a data URL. */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Rasterize SVG file text to PNG bytes at a pixel size, on white.
 *
 * @param dpi - The resolution to record.
 */
export async function rasterizeSvg(
  svg: string,
  size: PixelSize,
  dpi: number,
): Promise<Uint8Array> {
  const image = new Image()
  image.decoding = 'async'
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () =>
      reject(new Error('The figure could not be drawn as PNG.'))
  })
  image.src = `data:image/svg+xml;base64,${base64Utf8(svg)}`
  await loaded
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('The figure could not be drawn as PNG.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(image, 0, 0, size.width, size.height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  )
  if (!blob) throw new Error('The figure could not be drawn as PNG.')
  return withPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi)
}
