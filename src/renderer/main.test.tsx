import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupraspinaApi } from '../shared/contract'

const bootstrapMocks = vi.hoisted(() => ({
  installMockSupraspina: vi.fn(),
  render: vi.fn(),
  createRoot: vi.fn(),
}))

vi.mock('react-dom/client', () => ({
  createRoot: bootstrapMocks.createRoot,
}))

vi.mock('./App', () => ({
  default: function TestApp() {
    return null
  },
}))

vi.mock('./ipc/mock', () => ({
  installMockSupraspina: bootstrapMocks.installMockSupraspina,
}))

describe('renderer bootstrap', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete (globalThis as { supraspina?: SupraspinaApi }).supraspina
    document.body.innerHTML = '<div id="root"></div>'
    bootstrapMocks.createRoot.mockReturnValue({
      render: bootstrapMocks.render,
      unmount: vi.fn(),
    })
  })

  it('installs the browser bridge and mounts the application', async () => {
    await import('./main')

    const container = document.getElementById('root')
    expect(bootstrapMocks.installMockSupraspina).toHaveBeenCalledOnce()
    expect(bootstrapMocks.createRoot).toHaveBeenCalledWith(container)
    expect(bootstrapMocks.render).toHaveBeenCalledOnce()

    const rendered = bootstrapMocks.render.mock.calls[0]?.[0]
    expect(rendered).toMatchObject({
      props: {
        children: expect.objectContaining({ type: expect.any(Function) }),
      },
    })
  })

  it('preserves an Electron-provided bridge', async () => {
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina =
      {} as SupraspinaApi

    await import('./main')

    expect(bootstrapMocks.installMockSupraspina).not.toHaveBeenCalled()
    expect(bootstrapMocks.createRoot).toHaveBeenCalledOnce()
    expect(bootstrapMocks.render).toHaveBeenCalledOnce()
  })

  it('fails clearly when the root container is missing', async () => {
    document.body.innerHTML = ''

    await expect(import('./main')).rejects.toThrow(
      'Provide the #root container before starting the renderer.',
    )
    expect(bootstrapMocks.createRoot).not.toHaveBeenCalled()
    expect(bootstrapMocks.render).not.toHaveBeenCalled()
  })
})
