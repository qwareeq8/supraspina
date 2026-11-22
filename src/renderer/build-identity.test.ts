import { afterEach, describe, expect, it, vi } from 'vitest'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('APP_BUILD_IDENTITY', () => {
  it('reports an unknown build when the build embedded no record', async () => {
    const { APP_BUILD_IDENTITY } = await import('./build-identity')
    expect(APP_BUILD_IDENTITY).toEqual({
      kind: 'unknown',
      commit: '',
      dirty: false,
    })
  })

  it('reads the record the renderer build embedded', async () => {
    vi.stubGlobal('__SUPRASPINA_BUILD_IDENTITY__', {
      kind: 'development',
      commit: COMMIT,
      dirty: true,
    })
    const { APP_BUILD_IDENTITY } = await import('./build-identity')
    expect(APP_BUILD_IDENTITY).toEqual({
      kind: 'development',
      commit: COMMIT,
      dirty: true,
    })
  })
})
