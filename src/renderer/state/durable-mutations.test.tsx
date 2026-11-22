import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectRef } from '../../shared/types'
import { DurableMutationsProvider } from './durable-mutations'
import { useDurableMutations } from './durable-mutations-state'

const PROJECT_A: ProjectRef = {
  projectId: 'project-a',
  root: '/project-a',
  configPath: '/project-a/supraspina.project.json',
  epoch: 4,
}

const PROJECT_B: ProjectRef = {
  projectId: 'project-b',
  root: '/project-b',
  configPath: '/project-b/supraspina.project.json',
  epoch: 5,
}

function wrapper({ children }: { children: ReactNode }) {
  return <DurableMutationsProvider>{children}</DurableMutationsProvider>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

describe('project-scoped durable mutations', () => {
  it('serializes an active write and coalesces queued changes to the latest', async () => {
    const first = deferred<void>()
    const calls: string[] = []
    const { result } = renderHook(() => useDurableMutations(), { wrapper })

    let firstCompletion!: Promise<void>
    let replacedCompletion!: Promise<void>
    let latestCompletion!: Promise<void>
    act(() => {
      firstCompletion = result.current.enqueue(PROJECT_A, 'qc:sub-001', () => {
        calls.push('first')
        return first.promise
      })
      replacedCompletion = result.current.enqueue(
        PROJECT_A,
        'qc:sub-001',
        async () => {
          calls.push('replaced')
        },
      )
      latestCompletion = result.current.enqueue(
        PROJECT_A,
        'qc:sub-001',
        async () => {
          calls.push('latest')
        },
      )
    })

    expect(calls).toEqual(['first'])
    expect(result.current.snapshot(PROJECT_A).pendingCount).toBe(1)
    await act(async () => {
      first.resolve()
      await Promise.all([firstCompletion, replacedCompletion, latestCompletion])
    })

    expect(calls).toEqual(['first', 'latest'])
    await waitFor(() =>
      expect(result.current.snapshot(PROJECT_A).pendingCount).toBe(0),
    )
  })

  it('retains a failed write and retries it during an explicit flush', async () => {
    let attempts = 0
    const { result } = renderHook(() => useDurableMutations(), { wrapper })

    await act(async () => {
      await expect(
        result.current.enqueue(PROJECT_A, 'qc:sub-002', async () => {
          attempts += 1
          if (attempts === 1) throw new Error('revision conflict')
        }),
      ).rejects.toThrow('revision conflict')
    })

    expect(result.current.snapshot(PROJECT_A)).toEqual({
      pendingCount: 1,
      failedCount: 1,
    })
    await act(async () => result.current.flush(PROJECT_A))
    expect(attempts).toBe(2)
    expect(result.current.snapshot(PROJECT_A)).toEqual({
      pendingCount: 0,
      failedCount: 0,
    })
  })

  it('does not clear a newer draft that appears during a save', async () => {
    const saving = deferred<void>()
    const save = vi.fn(() => saving.promise)
    const { result } = renderHook(() => useDurableMutations(), { wrapper })
    let unregister: () => void = () => undefined

    act(() => {
      unregister = result.current.registerDraft({
        project: PROJECT_A,
        id: 'qc-note:sub-001',
        revision: 'note one',
        dirty: true,
        save,
        discard: vi.fn(),
      })
    })
    let flush!: Promise<void>
    act(() => {
      flush = result.current.flush(PROJECT_A)
    })
    expect(save).toHaveBeenCalledOnce()

    act(() => {
      result.current.updateDraft({
        project: PROJECT_A,
        id: 'qc-note:sub-001',
        revision: 'note two',
        dirty: true,
        save,
        discard: vi.fn(),
      })
      saving.resolve()
    })
    await expect(flush).rejects.toThrow(
      'Review the newer persistent edit before retrying the save.',
    )
    expect(result.current.snapshot(PROJECT_A).pendingCount).toBe(1)
    unregister()
  })

  it('keeps project epochs isolated and waits for accepted writes on discard', async () => {
    const active = deferred<void>()
    const discardDraft = vi.fn()
    const { result } = renderHook(() => useDurableMutations(), { wrapper })

    act(() => {
      result.current.registerDraft({
        project: PROJECT_A,
        id: 'registry-form',
        revision: 'draft',
        dirty: true,
        save: vi.fn(),
        discard: discardDraft,
      })
      void result.current
        .enqueue(PROJECT_A, 'registry:sub-003', () => active.promise)
        .catch(() => undefined)
    })
    expect(result.current.snapshot(PROJECT_A).pendingCount).toBe(2)
    expect(result.current.snapshot(PROJECT_B).pendingCount).toBe(0)

    let discarded = false
    let discardPromise!: Promise<void>
    act(() => {
      discardPromise = result.current.discard(PROJECT_A).then(() => {
        discarded = true
      })
    })
    await Promise.resolve()
    expect(discarded).toBe(false)
    expect(discardDraft).not.toHaveBeenCalled()

    await act(async () => {
      active.resolve()
      await discardPromise
    })
    expect(discardDraft).toHaveBeenCalledOnce()
    expect(result.current.snapshot(PROJECT_A).pendingCount).toBe(0)
  })
})
