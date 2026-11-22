// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { appZoom, supportsWebGl2 } from './support'
import unavailableCodec from './zarr-codec-stub'

describe('display probes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.style.removeProperty('--ss-zoom')
  })

  it('reports WebGL2 and releases the probe context', () => {
    const loseContext = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      getExtension: () => ({ loseContext }),
    } as never)
    expect(supportsWebGl2()).toBe(true)
    expect(loseContext).toHaveBeenCalled()
  })

  it('reports a display without WebGL2 or with a failing probe', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(supportsWebGl2()).toBe(false)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => {
        throw new Error('blocked')
      },
    )
    expect(supportsWebGl2()).toBe(false)
  })

  it('reads the app zoom, defaulting to 1', () => {
    expect(appZoom()).toBe(1)
    document.documentElement.style.setProperty('--ss-zoom', '1.35')
    expect(appZoom()).toBe(1.35)
    document.documentElement.style.setProperty('--ss-zoom', 'zero')
    expect(appZoom()).toBe(1)
  })

  it('stands in for the Zarr codecs by refusing them', () => {
    expect(() => unavailableCodec.fromConfig()).toThrow(
      /Zarr compression codecs are not part of Supraspina/,
    )
  })
})
