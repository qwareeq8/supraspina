// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  axesBox,
  keyBorderWhite,
  keyedPage,
  requestKeyedPage,
  useKeyedPage,
} from './montage-page'

type Rgba = readonly [number, number, number, number]

const WHITE: Rgba = [255, 255, 255, 255]
const BLACK: Rgba = [0, 0, 0, 255]
const RED: Rgba = [255, 0, 0, 255]
const GRAY: Rgba = [120, 124, 140, 255]
const CLEAR: Rgba = [0, 0, 0, 0]

/** A synthetic image drawn from rows of one-letter pixel codes. */
function image(rows: string[], key: Record<string, Rgba>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(rows.length * rows[0]!.length * 4)
  rows.forEach((row, y) => {
    ;[...row].forEach((code, x) => {
      data.set(key[code]!, (y * row.length + x) * 4)
    })
  })
  return data
}

function pixel(data: Uint8ClampedArray, width: number, x: number, y: number) {
  const at = (y * width + x) * 4
  return [...data.slice(at, at + 4)]
}

describe('keyBorderWhite', () => {
  // A MATLAB-like page: white around a black axes with a gray brain, a white
  // Left label box inside the axes, and a red subject tag on the axes edge.
  const page = [
    'wwwwwwwwwwww',
    'wwwwwwwwwwww',
    'wwbbbbbbbbww',
    'wwbWWbgggbww',
    'wwbbbbgggbww',
    'wwbggggggbww',
    'wwbbbbbbbbww',
    'wrrrrwwwwwww',
    'wrWWrwwwwwww',
    'wrrrrwwwwwww',
  ]
  const key = { w: WHITE, W: WHITE, b: BLACK, g: GRAY, r: RED }

  it('removes the border-connected white and keeps enclosed white', () => {
    const width = page[0]!.length
    const data = image(page, key)
    const before = data.slice()
    const { removed, bounds } = keyBorderWhite(data, width, page.length)
    let expected = 0
    page.forEach((row, y) => {
      ;[...row].forEach((code, x) => {
        const got = pixel(data, width, x, y)
        if (code === 'w') {
          expected += 1
          expect(got).toEqual([...CLEAR])
        } else {
          // Every other pixel keeps its exact value, the enclosed white too.
          expect(got).toEqual(pixel(before, width, x, y))
        }
      })
    })
    expect(removed).toBe(expected)
    expect(bounds).toEqual({ x: 1, y: 2, width: 9, height: 8 })
  })

  it('keeps a label box that meets the page at the axes edge', () => {
    // In a scaled gallery panel the Right box ends at the axes edge, so its
    // white touches the page's; the flood stops at the axes.
    const rows = [
      'wwwwwwwwwwww',
      'wbbbbbbWWWWw',
      'wbgggbbWWWWw',
      'wbgggggbbbbw',
      'wbgggggggbbw',
      'wbbgggggggbw',
      'wbbbbbbbbbbw',
      'wrrrwwwwwwww',
      'wwwwwwwwwwww',
    ]
    const width = rows[0]!.length
    const data = image(rows, { w: WHITE, W: WHITE, b: BLACK, g: GRAY, r: RED })
    const box = keyBorderWhite(data, width, rows.length)
    for (const [x, y] of [
      [7, 1],
      [10, 1],
      [10, 2],
    ] as const) {
      expect(pixel(data, width, x, y)).toEqual([...WHITE])
    }
    expect(pixel(data, width, 11, 1)).toEqual([...CLEAR])
    expect(pixel(data, width, 5, 7)).toEqual([...CLEAR])
    expect(box.bounds).toEqual({ x: 1, y: 1, width: 10, height: 7 })
  })

  it('finds the axes from the mostly drawn rows and columns', () => {
    const rows = ['wwwwww', 'wbbbbw', 'wbWbbw', 'wrwwww', 'wwwwww']
    const data = image(rows, { w: WHITE, W: WHITE, b: BLACK, r: RED })
    const white = new Uint8Array(30)
    for (let i = 0; i < 30; i += 1)
      white[i] = data[i * 4] === 255 && data[i * 4 + 1] === 255 ? 1 : 0
    expect(axesBox(white, 6, 5)).toEqual({ x: 1, y: 1, width: 4, height: 2 })
    expect(axesBox(new Uint8Array(4).fill(1), 2, 2)).toBeNull()
  })

  it('floods through 4-neighbors only', () => {
    // The center white touches the border white only at its corners.
    const rows = ['wbw', 'bwb', 'wbw']
    const data = image(rows, { w: WHITE, b: BLACK })
    const { removed } = keyBorderWhite(data, 3, 3)
    expect(removed).toBe(4)
    expect(pixel(data, 3, 1, 1)).toEqual([...WHITE])
  })

  it('keys only exact opaque white', () => {
    const near: Rgba = [255, 255, 254, 255]
    const faint: Rgba = [255, 255, 255, 200]
    const rows = ['nfw', 'bbb']
    const data = image(rows, { n: near, f: faint, w: WHITE, b: BLACK })
    const { removed, bounds } = keyBorderWhite(data, 3, 2)
    expect(removed).toBe(1)
    expect(pixel(data, 3, 0, 0)).toEqual([...near])
    expect(pixel(data, 3, 1, 0)).toEqual([...faint])
    expect(bounds).toEqual({ x: 0, y: 0, width: 3, height: 2 })
  })

  it('leaves a render on black unchanged', () => {
    const rows = ['bbbb', 'bggb', 'bgWb', 'bbbb']
    const data = image(rows, { b: BLACK, g: GRAY, W: WHITE })
    const before = data.slice()
    const result = keyBorderWhite(data, 4, 4)
    expect(result).toEqual({
      removed: 0,
      bounds: { x: 0, y: 0, width: 4, height: 4 },
    })
    expect(data).toEqual(before)
  })

  it('reports no bounds for an all-white page', () => {
    const data = image(['ww', 'ww'], { w: WHITE })
    expect(keyBorderWhite(data, 2, 2)).toEqual({ removed: 4, bounds: null })
  })
})

describe('keyedPage', () => {
  it('shows the stored image where no canvas can key it', async () => {
    const url = 'data:image/png;base64,AAAA'
    await expect(keyedPage(url)).resolves.toBe(url)
    const { result } = renderHook(() => useKeyedPage(url))
    expect(result.current).toBe(url)
    expect(renderHook(() => useKeyedPage(null)).result.current).toBeNull()
  })
})

/** Stored images the fake decoder knows, by data URL. */
const stored = new Map<
  string,
  { width: number; height: number; data: Uint8ClampedArray }
>()
const decoded: string[] = []

/**
 * Chromium's idle-period encoder. A busy renderer grants no idle period, so
 * it stands in as a promise that never settles; keying must not use it.
 */
const idleEncode = vi.fn(() => new Promise<Blob>(() => undefined))

/**
 * Stand in for Chromium's decoder and canvases: an image decodes to the
 * pixels stored under its URL, a canvas keeps its pixels, and a PNG data URL
 * carries the canvas size and pixels as JSON.
 */
function stubRenderer(): void {
  class FakeImage {
    src = ''
    decode = async (): Promise<void> => undefined
  }
  class FakeCanvas {
    pixels = new Uint8ClampedArray(0)
    constructor(
      public width = 0,
      public height = 0,
    ) {}
    getContext(): unknown {
      if (this.pixels.length !== this.width * this.height * 4) {
        this.pixels = new Uint8ClampedArray(this.width * this.height * 4)
      }
      return {
        drawImage: (bitmap: { data: Uint8ClampedArray }) => {
          this.pixels = bitmap.data.slice()
        },
        getImageData: () => ({
          data: this.pixels,
          width: this.width,
          height: this.height,
        }),
        putImageData: (
          image: { data: Uint8ClampedArray; width: number },
          dx: number,
          dy: number,
        ) => {
          for (let y = 0; y < this.height; y += 1) {
            for (let x = 0; x < this.width; x += 1) {
              const from = ((y - dy) * image.width + (x - dx)) * 4
              this.pixels.set(
                image.data.slice(from, from + 4),
                (y * this.width + x) * 4,
              )
            }
          }
        },
      }
    }
    convertToBlob = idleEncode
    toBlob = idleEncode
    toDataURL(): string {
      const body = JSON.stringify({
        w: this.width,
        h: this.height,
        data: [...this.pixels],
      })
      return `data:image/png;base64,${btoa(body)}`
    }
  }
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('OffscreenCanvas', FakeCanvas)
  const createElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(
    (tag: string, options?: ElementCreationOptions) =>
      tag === 'canvas'
        ? (new FakeCanvas() as unknown as HTMLElement)
        : createElement(tag, options),
  )
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (image: FakeImage) => {
      decoded.push(image.src)
      const found = stored.get(image.src)!
      return { ...found, close: () => undefined }
    }),
  )
}

function decodeResult(url: string): { w: number; h: number; data: number[] } {
  return JSON.parse(atob(url.slice(url.indexOf(',') + 1))) as {
    w: number
    h: number
    data: number[]
  }
}

describe('keying in the renderer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    idleEncode.mockClear()
    decoded.length = 0
  })

  it('decodes, keys, trims, and encodes a panel, and passes a render through', async () => {
    stubRenderer()
    const rows = ['wwwwww', 'wbbbbw', 'wbWgbw', 'wbbbbw', 'wrrwww', 'wwwwww']
    const data = image(rows, { w: WHITE, W: WHITE, b: BLACK, g: GRAY, r: RED })
    stored.set('data:image/png;base64,page', { width: 6, height: 6, data })
    const shown = await keyedPage('data:image/png;base64,page')
    const out = decodeResult(shown)
    expect([out.w, out.h]).toEqual([4, 4])
    const at = (x: number, y: number): number[] =>
      out.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)
    expect(at(1, 1)).toEqual([...WHITE])
    expect(at(2, 1)).toEqual([...GRAY])
    expect(at(0, 3)).toEqual([...RED])
    expect(at(3, 3)).toEqual([...CLEAR])
    // Cached: a second request neither decodes nor encodes again.
    await expect(keyedPage('data:image/png;base64,page')).resolves.toBe(shown)
    expect(decoded).toEqual(['data:image/png;base64,page'])
    expect(idleEncode).not.toHaveBeenCalled()

    const render = image(['bbb', 'bgb', 'bbb'], { b: BLACK, g: GRAY })
    stored.set('data:image/png;base64,render', {
      width: 3,
      height: 3,
      data: render,
    })
    await expect(keyedPage('data:image/png;base64,render')).resolves.toBe(
      'data:image/png;base64,render',
    )
  })

  it('keys the enlarged view first and drops released requests', async () => {
    stubRenderer()
    const page = image(['www', 'wbw', 'www'], { w: WHITE, b: BLACK })
    const urls = ['a', 'b', 'c', 'd'].map((n) => `data:image/png;base64,q${n}`)
    for (const url of urls) stored.set(url, { width: 3, height: 3, data: page })
    const ready: string[] = []
    const [a, b, c, d] = urls as [string, string, string, string]
    requestKeyedPage(a, 0, () => ready.push(a))
    requestKeyedPage(b, 0, () => ready.push(b))
    const releaseC = requestKeyedPage(c, 0, () => ready.push(c))
    requestKeyedPage(d, 1, () => ready.push(d))
    // The reviewer moved on before this panel started.
    releaseC()
    await vi.waitFor(() => expect(ready).toHaveLength(3))
    expect(decoded).toEqual([a, d, b])
    expect(ready).toEqual([a, d, b])
  })

  it('keys a panel without waiting for a renderer idle period', async () => {
    stubRenderer()
    const page = image(['www', 'wbw', 'www'], { w: WHITE, b: BLACK })
    const urls = Array.from(
      { length: 12 },
      (_, n) => `data:image/png;base64,idle${n}`,
    )
    for (const url of urls) stored.set(url, { width: 3, height: 3, data: page })
    // Every panel of a montage keys although no idle period ever comes.
    const shown = await Promise.all(urls.map((url) => keyedPage(url)))
    expect(shown.map((url) => decodeResult(url))).toEqual(
      urls.map(() => ({ w: 1, h: 1, data: [...BLACK] })),
    )
    expect(idleEncode).not.toHaveBeenCalled()
  })
})
