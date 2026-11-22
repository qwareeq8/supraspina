/** Tests that native handlers match the declared IPC surface exactly. */

import { describe, expect, it, vi } from 'vitest'
import surface from '../shared/ipc-surface.json'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => undefined },
  shell: {},
}))

describe('artifact path grants', () => {
  it('refuses an unrelated candidate when the exact grant names another path', async () => {
    const { artifactPathGranted } = await import('./ipc')
    const roots = ['/data/study/outputs', '/data/study/derivatives']
    const granted = '/home/researcher/exports/debug-bundle.zip'

    expect(artifactPathGranted(granted, roots, granted)).toBe(true)
    expect(
      artifactPathGranted(
        '/home/researcher/exports/other-bundle.zip',
        roots,
        granted,
      ),
    ).toBe(false)
    expect(artifactPathGranted('/etc/shadow', roots, granted)).toBe(false)
    expect(
      artifactPathGranted('/data/study/outputs/table.csv', roots, granted),
    ).toBe(true)
    expect(artifactPathGranted(granted, roots, null)).toBe(false)
  })
})

describe('native IPC handler coverage', () => {
  it('registers exactly the methods declared native in the surface map', async () => {
    const { nativeHandlers } = await import('./ipc')
    const keys = Object.keys(nativeHandlers()).sort()
    const expected = [...(surface.native as string[])].sort()
    expect(keys).toEqual(expected)
  })

  it('never registers a method classified sidecar or event (no shadowing)', async () => {
    // Prevent native dispatch from silently shadowing a sidecar or event method that
    // is also present natively. Catch this conflict independently of the renderer
    // suite.
    const { nativeHandlers } = await import('./ipc')
    const nonNative = new Set([
      ...(surface.sidecar as string[]),
      ...(surface.event as string[]),
    ])
    const shadowed = Object.keys(nativeHandlers()).filter((k) =>
      nonNative.has(k),
    )
    expect(shadowed).toEqual([])
  })
})
