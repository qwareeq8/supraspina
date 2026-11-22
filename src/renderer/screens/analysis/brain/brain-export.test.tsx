// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FIGURE_FONT_PT, mmToPt, textWidth } from '../../../figures/style'
import {
  MAX_RENDER_SCALE,
  brainFigurePng,
  contentBounds,
  renderScale,
} from './brain-export'
import { BrainFigure } from './brain-figure'
import { brainFigureLayout, wrapRich } from './brain-figure-layout'
import { richWidth } from '../../../figures/rich'
import { DIVERGING_STOPS } from './brain-map'

const raster = vi.hoisted(() => ({
  calls: [] as { svg: string; size: unknown; dpi: number }[],
}))
vi.mock('../../../figures/png-export', async (original) => ({
  ...(await original<typeof import('../../../figures/png-export')>()),
  rasterizeSvg: vi.fn(async (svg: string, size: unknown, dpi: number) => {
    raster.calls.push({ svg, size, dpi })
    return Uint8Array.from([137, 80, 78, 71])
  }),
}))

afterEach(() => {
  vi.restoreAllMocks()
  raster.calls.length = 0
})

/** A white RGBA frame with a gray block. */
function frame(
  width: number,
  height: number,
  block: { x: number; y: number; w: number; h: number },
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let y = block.y; y < block.y + block.h; y += 1) {
    for (let x = block.x; x < block.x + block.w; x += 1) {
      data.set([128, 128, 128, 255], (y * width + x) * 4)
    }
  }
  return data
}

const SCALE = {
  stat: 'd' as const,
  limit: 1.5,
  negative: 'Smaller in SCI',
  positive: 'Larger in SCI',
}

describe('brain figure', () => {
  it('crops to the drawn pixels with a margin inside the frame', () => {
    const data = frame(200, 100, { x: 50, y: 20, w: 100, h: 40 })
    expect(contentBounds(data, 200, 100, [255, 255, 255])).toEqual({
      x: 47,
      y: 17,
      width: 106,
      height: 46,
    })
    // Near the edge the margin stops at the frame.
    const edge = frame(200, 100, { x: 0, y: 0, w: 10, h: 10 })
    expect(contentBounds(edge, 200, 100, [255, 255, 255])).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })
    expect(
      contentBounds(
        frame(4, 4, { x: 0, y: 0, w: 0, h: 0 }),
        4,
        4,
        [255, 255, 255],
      ),
    ).toBeNull()
  })

  it('renders at the export resolution within the cap', () => {
    expect(renderScale(330, 1650)).toBe(5)
    expect(renderScale(330, 200)).toBe(1)
    expect(renderScale(100, 5000)).toBe(MAX_RENDER_SCALE)
    expect(renderScale(0, 500)).toBe(1)
  })

  it('keeps a tall render within the figure', () => {
    const wide = brainFigureLayout(400, { width: 800, height: 400 }, [], SCALE)
    expect(wide.image.w).toBeCloseTo(392)
    expect(wide.image.x).toBeCloseTo(4)
    const tall = brainFigureLayout(400, { width: 400, height: 800 }, [], SCALE)
    expect(tall.image.h).toBeCloseTo(320)
    expect(tall.image.w).toBeCloseTo(160)
    expect(tall.image.x).toBeCloseTo(120)
    expect(tall.height).toBeGreaterThan(tall.image.y + tall.image.h)
  })

  it('fits every text of an 85 mm figure inside its margins', () => {
    const width = mmToPt(85)
    const long = {
      ...SCALE,
      negative: 'Smaller in Spinal cord injury',
      positive: 'Larger in Spinal cord injury',
    }
    const caption = [
      [
        'Spinal cord injury (',
        { i: 'n' },
        ' = 34) vs Control (',
        { i: 'n' },
        ' = 48)',
      ],
      [
        "Gray matter volume, per hemisphere; cut at \u22128 mm, azimuth 355\u00b0, elevation \u221285\u00b0, through a subject's volumes",
      ],
      ['outlined: FWE ', { i: 'p' }, ' < 0.05 over the 150 measures'],
    ] as const
    const { container } = render(
      <BrainFigure
        image={{ href: 'data:image/png;base64,AAAA', width: 800, height: 400 }}
        width={width}
        widthMm={85}
        lines={caption}
        scale={long}
        title="Brain map: test"
        summary="A summary."
      />,
    )
    const texts = [...container.querySelectorAll('text')]
    for (const text of texts) {
      const x = Number(text.getAttribute('x'))
      const w = textWidth(text.textContent ?? '', FIGURE_FONT_PT)
      const left = text.getAttribute('text-anchor') === 'end' ? x - w : x
      expect(left).toBeGreaterThanOrEqual(3.99)
      expect(left + w).toBeLessThanOrEqual(width - 3.99)
    }
    // The long view line wraps rather than running off the page.
    const all = texts.map((t) => t.textContent ?? '').join(' ')
    expect(all).toContain('Smaller in Spinal cord injury')
    expect(all).toContain("through a subject's volumes")
    const layout = brainFigureLayout(
      width,
      { width: 800, height: 400 },
      caption,
      long,
    )
    expect(layout.lines.length).toBeGreaterThan(3)
    expect(layout.image.y).toBeGreaterThan(layout.lines.at(-1)!.y)
  })

  it('wraps a rich line at spaces and keeps its italics', () => {
    const lines = wrapRich(['a b c ', { i: 'p' }, ' d'], 7, 12)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.flat()).toContainEqual({ i: 'p' })
    for (const line of lines) expect(richWidth(line, 7)).toBeLessThanOrEqual(12)
  })

  it('draws the render with its color scale and caption in print colors', () => {
    const { container, getByRole } = render(
      <BrainFigure
        image={{ href: 'data:image/png;base64,AAAA', width: 800, height: 400 }}
        width={mmToPt(174)}
        widthMm={174}
        lines={[['SCI vs CTRL'], ['Thickness; left hemisphere']]}
        scale={SCALE}
        title="Brain map: test"
        summary="A summary."
      />,
    )
    const svg = getByRole('img', { name: 'Brain map: test' })
    expect(svg.getAttribute('width')).toBe('174mm')
    expect(svg.querySelector('image')?.getAttribute('href')).toBe(
      'data:image/png;base64,AAAA',
    )
    expect(svg.querySelectorAll('stop')).toHaveLength(DIVERGING_STOPS.length)
    const text = container.textContent ?? ''
    for (const part of [
      'SCI vs CTRL',
      'Thickness; left hemisphere',
      'Smaller in SCI',
      '\u22121.50',
      '1.50',
      'Larger in SCI',
      'Significant',
      'Not significant',
    ]) {
      expect(text).toContain(part)
    }
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#ffffff')
  })

  /** A fake export frame whose regions read from one RGBA buffer. */
  function fakeFrame(
    width: number,
    height: number,
    data: Uint8ClampedArray,
    tiles:
      | { x: number; y: number; width: number; height: number }[]
      | null = null,
  ): { canvas: HTMLCanvasElement; tiles: typeof tiles } {
    const region = (x: number, y: number, w: number, h: number) => {
      const out = new Uint8ClampedArray(w * h * 4)
      for (let row = 0; row < h; row += 1) {
        const from = ((y + row) * width + x) * 4
        out.set(data.subarray(from, from + w * 4), row * w * 4)
      }
      return { data: out, width: w, height: h }
    }
    return {
      canvas: {
        width,
        height,
        getContext: () => ({ getImageData: region }),
      } as unknown as HTMLCanvasElement,
      tiles,
    }
  }

  /** Stub the 2D contexts of the canvases the composition makes. */
  function stubComposition(): {
    made: [number, number][]
    puts: [number, number, number][]
    scaled: [number, number][]
  } {
    const made: [number, number][] = []
    const puts: [number, number, number][] = []
    const scaled: [number, number][] = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      function (this: HTMLCanvasElement) {
        made.push([this.width, this.height])
        return {
          putImageData: (image: { width: number }, x: number, y: number) =>
            puts.push([image.width, x, y]),
          fillRect: () => undefined,
          drawImage: (
            _source: unknown,
            _x: number,
            _y: number,
            w: number,
            h: number,
          ) => scaled.push([w, h]),
        } as never
      },
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,QUJD',
    )
    return { made, puts, scaled }
  }

  const REQUEST = {
    background: [1, 1, 1] as const,
    widthMm: 85,
    dpi: 300,
    lines: [['SCI vs CTRL']],
    scale: SCALE,
    title: 'Brain map: test',
    summary: 'A summary.',
  }

  it('shapes the canvas like the brain, renders it at its width, and rasterizes', async () => {
    const requests: { scale: number; aspect?: number | null }[] = []
    const render = (request: { scale: number; aspect?: number | null }) => {
      requests.push(request)
      const { scale } = request
      const width = Math.round(200 * scale)
      const height = Math.round(100 * scale)
      return fakeFrame(
        width,
        height,
        frame(width, height, {
          x: Math.round(25 * scale),
          y: Math.round(20 * scale),
          w: Math.round(150 * scale),
          h: Math.round(50 * scale),
        }),
      )
    }
    const { made } = stubComposition()
    const png = await brainFigurePng((draw) => draw(render), REQUEST)
    expect(Array.from(png)).toEqual([137, 80, 78, 71])
    // The first frame measures the brain (160 x 60 px with its margin), the
    // second shapes the canvas like it, and the third draws it at its width
    // in the PNG, 233 pt at 300 dpi.
    expect(requests[0]).toEqual({ scale: 1 })
    expect(requests[1]).toEqual({ scale: 1, aspect: 160 / 60 })
    expect(requests[2]!.scale).toBeCloseTo(
      (((mmToPt(85) - 8) / 72) * 300) / 160,
      3,
    )
    expect(made).toHaveLength(1)
    const { svg, size, dpi } = raster.calls[0]!
    expect(dpi).toBe(300)
    expect((size as { width: number }).width).toBe(1004)
    expect(svg).toContain('data:image/png;base64,QUJD')
    expect(svg).toContain('width="85mm"')
  })

  it('supersamples a render and scales it down to the export width', async () => {
    const requests: number[] = []
    const render = ({ scale }: { scale: number }) => {
      requests.push(scale)
      const width = Math.round(200 * scale)
      const height = Math.round(100 * scale)
      return fakeFrame(
        width,
        height,
        frame(width, height, {
          x: Math.round(25 * scale),
          y: Math.round(20 * scale),
          w: Math.round(150 * scale),
          h: Math.round(50 * scale),
        }),
      )
    }
    const { scaled } = stubComposition()
    await brainFigurePng((draw) => draw(render), {
      ...REQUEST,
      dpi: 150,
      supersample: 2,
    })
    const target = (((mmToPt(85) - 8) / 72) * 150) / 160
    expect(requests[2]).toBeCloseTo(2 * target, 3)
    // The composed render is scaled down to the PNG's width of the brain.
    expect(scaled).toHaveLength(1)
    expect(scaled[0]![0]).toBeCloseTo(((mmToPt(85) - 8) / 72) * 150, -1)
  })

  it('cuts slice panes to one brain box and sets them apart', async () => {
    // Three 100 px panes on black, each with a brain 60 x 50 px at its own
    // place; the composition cuts every pane to the union of the brains.
    const width = 300
    const height = 100
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 3; i < data.length; i += 4) data[i] = 255
    const brains = [
      { x: 20, y: 25 },
      { x: 120, y: 20 },
      { x: 220, y: 30 },
    ]
    for (const brain of brains) {
      for (let y = brain.y; y < brain.y + 50; y += 1) {
        for (let x = brain.x; x < brain.x + 60; x += 1) {
          data.set([200, 200, 200, 255], (y * width + x) * 4)
        }
      }
    }
    const tiles = [0, 100, 200].map((x) => ({ x, y: 0, width: 100, height }))
    const requests: { scale: number; aspect?: number | null }[] = []
    const render = (request: { scale: number; aspect?: number | null }) => {
      requests.push(request)
      return fakeFrame(width, height, data, tiles)
    }
    const { made, puts } = stubComposition()
    await brainFigurePng((draw) => draw(render), {
      ...REQUEST,
      background: [0, 0, 0],
    })
    // The canvas is shaped for three square panes.
    expect(requests[1]).toEqual({ scale: 1, aspect: 3 })
    // Union of the brains within their panes: x 20..80, y 20..80, plus a
    // 3% margin; the panes sit side by side with a 4% gap.
    const pane = puts.map(([w]) => w)
    expect(new Set(pane).size).toBe(1)
    const gap = Math.round(0.04 * pane[0]!)
    expect(puts.map(([, x]) => x)).toEqual([
      0,
      pane[0]! + gap,
      2 * (pane[0]! + gap),
    ])
    expect(made[0]![0]).toBe(3 * pane[0]! + 2 * gap)
  })
})
