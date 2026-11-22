import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  appOn: vi.fn(),
  invalidateActiveProject: vi.fn(async () => undefined),
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
    whenReady: () => new Promise<void>(() => undefined),
    on: mocks.appOn,
    quit: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: () => [],
  }),
  session: { fromPartition: vi.fn() },
}))

vi.mock('./ipc', () => ({
  invalidateActiveProject: mocks.invalidateActiveProject,
  registerIpc: vi.fn(() => vi.fn()),
}))

vi.mock('./sidecar', () => ({
  Sidecar: vi.fn(),
}))

vi.mock('./autoupdate', () => ({
  autoUpdate: {
    canInstall: vi.fn(async () => false),
    checkOnLaunch: vi.fn(async () => false),
    installNow: vi.fn(async () => false),
  },
  initAutoUpdate: vi.fn(),
}))

import {
  finishPackageSmokeProcessExit,
  installUpdateAtBoundary,
  NativeUnloadApprovalGate,
  shouldRunPackageSmoke,
} from './index'
import { PACKAGE_SMOKE_FLAG } from './package-smoke'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('native unload approval', () => {
  it('leaves an unapproved renderer veto fail-closed', () => {
    const gate = new NativeUnloadApprovalGate()
    const event = { preventDefault: vi.fn() }

    expect(gate.permit({}, event)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('permits one veto only for the exact approved window', () => {
    const gate = new NativeUnloadApprovalGate()
    const approvedWindow = {}
    const otherWindow = {}
    const event = { preventDefault: vi.fn() }
    gate.approve(approvedWindow, 'window-close')

    expect(gate.permit(otherWindow, event)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(gate.permit(approvedWindow, event)).toBe('window-close')
    expect(event.preventDefault).toHaveBeenCalledOnce()

    event.preventDefault.mockClear()
    expect(gate.permit(approvedWindow, event)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('revokes only the exact pending boundary token', () => {
    const gate = new NativeUnloadApprovalGate()
    const win = {}
    const stale = gate.approve(win, 'renderer-reload')
    gate.approve(win, 'app-quit')
    gate.revoke(stale)
    const event = { preventDefault: vi.fn() }

    expect(gate.permit(win, event)).toBe('app-quit')
    expect(event.preventDefault).toHaveBeenCalledOnce()

    const failed = gate.approve(win, 'update-install')
    gate.revoke(failed)
    event.preventDefault.mockClear()
    expect(gate.permit(win, event)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('expires unused approval rather than authorizing a later unload', () => {
    vi.useFakeTimers()
    const gate = new NativeUnloadApprovalGate(50)
    const win = {}
    const event = { preventDefault: vi.fn() }
    gate.approve(win, 'update-install')

    vi.advanceTimersByTime(50)

    expect(gate.permit(win, event)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('fails closed when wall-clock expiry precedes the cleanup timer', () => {
    vi.useFakeTimers()
    const gate = new NativeUnloadApprovalGate(1_000)
    const win = {}
    const event = { preventDefault: vi.fn() }
    gate.approve(win, 'renderer-reload')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_001)

    expect(gate.permit(win, event)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('clears an approval only when its owning window closes', () => {
    const gate = new NativeUnloadApprovalGate()
    const owner = {}
    const other = {}
    const event = { preventDefault: vi.fn() }
    gate.approve(owner, 'window-close')

    gate.clearWindow(other)
    expect(gate.permit(owner, event)).toBe('window-close')
    gate.approve(owner, 'app-quit')
    gate.clearWindow(owner)
    expect(gate.permit(owner, event)).toBeNull()
  })
})

describe('packaged smoke startup integration', () => {
  it('keeps normal and development launches outside smoke mode', () => {
    expect(shouldRunPackageSmoke(false, [PACKAGE_SMOKE_FLAG])).toBe(false)
    expect(shouldRunPackageSmoke(true, [])).toBe(false)
  })

  it('requires the exact explicit flag in a packaged launch', () => {
    expect(
      shouldRunPackageSmoke(true, ['supraspina', PACKAGE_SMOKE_FLAG]),
    ).toBe(true)
    expect(shouldRunPackageSmoke(true, [`${PACKAGE_SMOKE_FLAG}=true`])).toBe(
      false,
    )
  })
})

describe('packaged smoke native exit', () => {
  it('never touches native process exit outside explicit smoke mode', () => {
    const runtime = { reallyExit: vi.fn(), exit: vi.fn() }

    expect(() => finishPackageSmokeProcessExit(false, 0, runtime)).not.toThrow()
    expect(runtime.reallyExit).not.toHaveBeenCalled()
    expect(runtime.exit).not.toHaveBeenCalled()
  })

  it.each([
    [0, 0, 1],
    [7, 7, 7],
    [Number.NaN, 1, 1],
    [256, 1, 1],
  ])(
    'forwards requested code %s and cannot treat a returning native exit as success',
    (requested, nativeCode, fallbackCode) => {
      const runtime = { reallyExit: vi.fn(), exit: vi.fn() }

      expect(() =>
        finishPackageSmokeProcessExit(true, requested, runtime),
      ).toThrow(/Keep the native package-smoke process exit from returning/)
      expect(runtime.reallyExit).toHaveBeenCalledWith(nativeCode)
      expect(runtime.exit).toHaveBeenCalledWith(fallbackCode)
    },
  )

  it('fails closed when the native exit primitive is unavailable', () => {
    const runtime = { exit: vi.fn() }

    expect(() => finishPackageSmokeProcessExit(true, 0, runtime)).toThrow(
      /Keep the native package-smoke process exit from returning/,
    )
    expect(runtime.exit).toHaveBeenCalledWith(1)
  })
})

describe('update lifecycle crossing', () => {
  it('rejects before stopping when no downloaded update is ready', async () => {
    const runtime = {
      stop: vi.fn(async () => undefined),
      restartAfterStop: vi.fn(async () => undefined),
    }
    const installer = {
      canInstall: vi.fn(async () => false),
      installNow: vi.fn(async () => true),
    }
    const approve = vi.fn()
    const revoke = vi.fn()

    await expect(
      installUpdateAtBoundary(runtime, installer, approve, revoke),
    ).rejects.toThrow(/Download an update before installing it/)
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('supports a runtime-free install boundary', async () => {
    const installer = {
      canInstall: vi.fn(async () => true),
      installNow: vi.fn(async () => true),
    }
    const approve = vi.fn()
    const revoke = vi.fn()

    await expect(
      installUpdateAtBoundary(null, installer, approve, revoke),
    ).resolves.toBeUndefined()
    expect(approve).toHaveBeenCalledOnce()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('revokes approval without inventing a runtime restart when a runtime-free install refuses', async () => {
    const installer = {
      canInstall: vi.fn(async () => true),
      installNow: vi.fn(async () => false),
    }
    const approve = vi.fn()
    const revoke = vi.fn()

    await expect(
      installUpdateAtBoundary(null, installer, approve, revoke),
    ).rejects.toThrow(/Download the update again before installing it/)
    expect(approve).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('reports a distinct recovery failure after an update boundary stops the runtime', async () => {
    const runtime = {
      stop: vi.fn(async () => undefined),
      restartAfterStop: vi.fn(async () => {
        throw new Error('Restore the unavailable runtime.')
      }),
    }
    const installer = {
      canInstall: vi.fn(async () => true),
      installNow: vi.fn(async () => false),
    }

    await expect(
      installUpdateAtBoundary(runtime, installer, vi.fn(), vi.fn()),
    ).rejects.toThrow(/Retry the scientific runtime before continuing/)
    expect(runtime.restartAfterStop).toHaveBeenCalledOnce()
  })
  it('restarts the proved-stopped runtime when update readiness disappears', async () => {
    const runtime = {
      stop: vi.fn(async () => undefined),
      restartAfterStop: vi.fn(async () => undefined),
    }
    const installer = {
      canInstall: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      installNow: vi.fn(async () => true),
    }
    const approve = vi.fn()
    const revoke = vi.fn()

    await expect(
      installUpdateAtBoundary(runtime, installer, approve, revoke),
    ).rejects.toThrow(/Download the update again before installing it/)
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(runtime.restartAfterStop).toHaveBeenCalledOnce()
    expect(approve).not.toHaveBeenCalled()
    expect(revoke).toHaveBeenCalledOnce()
    expect(mocks.invalidateActiveProject).not.toHaveBeenCalled()
  })

  it('revokes quit approval and restores the runtime when install refuses to start', async () => {
    const runtime = {
      stop: vi.fn(async () => undefined),
      restartAfterStop: vi.fn(async () => undefined),
    }
    const installer = {
      canInstall: vi.fn(async () => true),
      installNow: vi.fn(async () => false),
    }
    const approve = vi.fn()
    const revoke = vi.fn()

    await expect(
      installUpdateAtBoundary(runtime, installer, approve, revoke),
    ).rejects.toThrow(/Download the update again before installing it/)
    expect(approve).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
    expect(runtime.restartAfterStop).toHaveBeenCalledOnce()
    expect(mocks.invalidateActiveProject).not.toHaveBeenCalled()
  })

  it('leaves the proved-stopped runtime stopped once installation begins', async () => {
    const runtime = {
      stop: vi.fn(async () => undefined),
      restartAfterStop: vi.fn(async () => undefined),
    }
    const installer = {
      canInstall: vi.fn(async () => true),
      installNow: vi.fn(async () => true),
    }
    const approve = vi.fn()
    const revoke = vi.fn()

    await expect(
      installUpdateAtBoundary(runtime, installer, approve, revoke),
    ).resolves.toBeUndefined()
    expect(approve).toHaveBeenCalledOnce()
    expect(revoke).not.toHaveBeenCalled()
    expect(runtime.restartAfterStop).not.toHaveBeenCalled()
  })
})
