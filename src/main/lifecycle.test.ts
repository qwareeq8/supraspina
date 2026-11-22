import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundaryCoordinator } from './lifecycle'
import type { BoundaryRequest } from '../shared/contract'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function harness(timeoutMs = 100) {
  const requests: BoundaryRequest[] = []
  const cross = vi.fn(async () => undefined)
  const coordinator = new BoundaryCoordinator({
    emit: (request) => requests.push(request),
    cross,
    timeoutMs,
  })
  return { coordinator, requests, cross }
}

describe('BoundaryCoordinator', () => {
  it('coalesces only duplicate intents and replays distinct intents in order', async () => {
    const { coordinator, requests, cross } = harness()
    const first = coordinator.request('window-close')
    const repeated = coordinator.request('window-close')
    const queued = coordinator.request('app-quit')
    const repeatedQueued = coordinator.request('app-quit')
    expect(repeated).toBe(first)
    expect(repeatedQueued).toBe(queued)
    expect(queued).not.toBe(first)
    expect(requests).toHaveLength(1)
    await coordinator.respond({
      requestId: requests[0]!.requestId,
      decision: 'cancel',
    })
    await expect(first).resolves.toBeUndefined()
    expect(cross).not.toHaveBeenCalled()
    expect(requests).toHaveLength(2)
    expect(requests[1]?.intent).toBe('app-quit')
    await coordinator.respond({
      requestId: requests[1]!.requestId,
      decision: 'proceed',
    })
    await expect(queued).resolves.toBeUndefined()
    expect(cross).toHaveBeenCalledWith('app-quit')
  })

  it('advances a queued intent after the active request times out', async () => {
    vi.useFakeTimers()
    const { coordinator, requests } = harness(25)
    const first = coordinator.request('renderer-reload')
    const queued = coordinator.request('update-install')
    const timedOut = expect(first).rejects.toMatchObject({
      code: 'BOUNDARY_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(26)
    await timedOut
    expect(requests.map((request) => request.intent)).toEqual([
      'renderer-reload',
      'update-install',
    ])
    await coordinator.respond({
      requestId: requests[1]!.requestId,
      decision: 'cancel',
    })
    await queued
  })

  it('crosses exactly the approved intent with a single-use token', async () => {
    const { coordinator, requests, cross } = harness()
    const requested = coordinator.request('update-install')
    const response = {
      requestId: requests[0]!.requestId,
      decision: 'proceed' as const,
    }
    await coordinator.respond(response)
    await requested
    expect(cross).toHaveBeenCalledOnce()
    expect(cross).toHaveBeenCalledWith('update-install')
    await expect(coordinator.respond(response)).rejects.toMatchObject({
      code: 'BOUNDARY_EXPIRED',
      message: 'Retry the confirmation because it expired before an answer.',
    })
  })

  it('rejects a forged response without disturbing the real request', async () => {
    const { coordinator, requests, cross } = harness()
    const requested = coordinator.request('renderer-reload')
    await expect(
      coordinator.respond({ requestId: 'forged', decision: 'proceed' }),
    ).rejects.toMatchObject({ code: 'BOUNDARY_EXPIRED' })
    expect(cross).not.toHaveBeenCalled()
    await coordinator.respond({
      requestId: requests[0]!.requestId,
      decision: 'cancel',
    })
    await requested
  })

  it('fails closed on timeout and permits a later retry', async () => {
    vi.useFakeTimers()
    const { coordinator, requests, cross } = harness(25)
    const first = coordinator.request('window-close')
    const timedOut = expect(first).rejects.toMatchObject({
      code: 'BOUNDARY_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(26)
    await timedOut
    expect(cross).not.toHaveBeenCalled()

    await expect(
      coordinator.respond({
        requestId: requests[0]!.requestId,
        decision: 'proceed',
      }),
    ).rejects.toMatchObject({ code: 'BOUNDARY_EXPIRED' })
    expect(cross).not.toHaveBeenCalled()

    const second = coordinator.request('window-close')
    expect(requests).toHaveLength(2)
    await coordinator.respond({
      requestId: requests[1]!.requestId,
      decision: 'cancel',
    })
    await second
  })

  it('keeps the boundary uncrossed when shutdown/crossing fails', async () => {
    const requests: BoundaryRequest[] = []
    const coordinator = new BoundaryCoordinator({
      emit: (request) => requests.push(request),
      cross: async () => {
        throw new Error('Resolve the unproved process exit.')
      },
    })
    const requested = coordinator.request('app-quit')
    const responding = coordinator.respond({
      requestId: requests[0]!.requestId,
      decision: 'proceed',
    })
    await expect(responding).rejects.toThrow(/unproved/)
    await expect(requested).rejects.toThrow(/unproved/)
  })

  it('fails closed when the renderer cannot present a confirmation', async () => {
    const cross = vi.fn(async () => undefined)
    const coordinator = new BoundaryCoordinator({
      emit: () => {
        throw new Error('Present the window before continuing.')
      },
      cross,
    })

    await expect(coordinator.request('window-close')).rejects.toThrow(
      /Present the boundary confirmation/,
    )
    expect(cross).not.toHaveBeenCalled()
  })

  it('rejects a second response while an approved boundary is still crossing', async () => {
    let finishCross!: () => void
    const crossing = new Promise<void>((resolve) => {
      finishCross = resolve
    })
    const requests: BoundaryRequest[] = []
    const coordinator = new BoundaryCoordinator({
      emit: (request) => requests.push(request),
      cross: () => crossing,
    })
    const requested = coordinator.request('renderer-reload')
    const response = {
      requestId: requests[0]!.requestId,
      decision: 'proceed' as const,
    }

    const firstResponse = coordinator.respond(response)
    await expect(coordinator.respond(response)).rejects.toThrow(
      /Wait for the current boundary response to settle/,
    )
    finishCross()
    await firstResponse
    await requested
  })

  it('normalizes a non-Error crossing failure without exposing its value', async () => {
    const requests: BoundaryRequest[] = []
    const coordinator = new BoundaryCoordinator({
      emit: (request) => requests.push(request),
      cross: async () =>
        Promise.reject('Expose sensitive implementation detail.'),
    })
    const requested = coordinator.request('app-quit')

    await expect(
      coordinator.respond({
        requestId: requests[0]!.requestId,
        decision: 'proceed',
      }),
    ).rejects.toThrow('Complete the requested boundary before continuing.')
    await expect(requested).rejects.toThrow(
      'Complete the requested boundary before continuing.',
    )
  })

  it('disposes active and queued requests and refuses later work', async () => {
    vi.useFakeTimers()
    const { coordinator } = harness(25)
    const active = coordinator.request('window-close')
    const queued = coordinator.request('app-quit')

    coordinator.dispose()

    await expect(active).rejects.toThrow(
      /Keep the lifecycle coordinator running/,
    )
    await expect(queued).rejects.toThrow(
      /Keep the lifecycle coordinator running/,
    )
    await expect(coordinator.request('renderer-reload')).rejects.toThrow(
      /Start the lifecycle coordinator before requesting a boundary/,
    )
    await vi.advanceTimersByTimeAsync(30)
  })

  it('does not settle twice if disposal races a crossing response', async () => {
    let finishCross!: () => void
    const crossing = new Promise<void>((resolve) => {
      finishCross = resolve
    })
    const requests: BoundaryRequest[] = []
    const coordinator = new BoundaryCoordinator({
      emit: (request) => requests.push(request),
      cross: () => crossing,
    })
    const requested = coordinator.request('update-install')
    const responding = coordinator.respond({
      requestId: requests[0]!.requestId,
      decision: 'proceed',
    })

    coordinator.dispose()
    await expect(requested).rejects.toThrow(
      /Keep the lifecycle coordinator running/,
    )
    finishCross()
    await expect(responding).resolves.toBeUndefined()
  })
})
