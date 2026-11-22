import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupraspinaApi, UpdateState } from '../../shared/contract'
import { createMockApi } from '../ipc/mock'
import { getApi, hasNativeBridge } from './api'
import {
  ProjectLifecycleContext,
  useProjectLifecycle,
} from './project-lifecycle-state'
import {
  RuntimeContext,
  logReplayCoverage,
  type RuntimeState,
  useRuntime,
} from './runtime-state'
import { useCopyFeedback } from './useCopyFeedback'
import { useUpdateStatus } from './use-update-status'

function updateState(patch: Partial<UpdateState> = {}): UpdateState {
  return {
    phase: 'idle',
    version: null,
    releaseNotes: null,
    percent: null,
    error: null,
    capability: 'noop',
    ...patch,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('renderer state hooks', () => {
  it('tracks pulled and pushed updater states and unsubscribes on unmount', async () => {
    const api = createMockApi()
    let emit: ((state: UpdateState) => void) | undefined
    const off = vi.fn()
    api.update.getStatus = vi
      .fn()
      .mockResolvedValue(updateState({ phase: 'idle' }))
    api.update.onStatus = vi.fn((listener) => {
      emit = listener
      return off
    })
    window.supraspina = api

    const { result, unmount } = renderHook(() => useUpdateStatus())
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current?.phase).toBe('idle'))

    act(() => emit?.(updateState({ phase: 'error', error: 'offline' })))
    expect(result.current).toMatchObject({ phase: 'error', error: 'offline' })

    unmount()
    expect(off).toHaveBeenCalledOnce()
    act(() => emit?.(updateState({ phase: 'available', version: '9.9.9' })))
  })

  it('tolerates an API without an updater namespace', () => {
    const api = createMockApi()
    Reflect.deleteProperty(api, 'update')
    window.supraspina = api

    const { result, unmount } = renderHook(() => useUpdateStatus())
    expect(result.current).toBeNull()
    expect(() => unmount()).not.toThrow()
  })

  it('reports clipboard success, resets the latest marker, and reports failure', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { result, unmount } = renderHook(() => useCopyFeedback(1_000))

    await act(async () => {
      expect(await result.current.copy('first', 'alpha')).toBe(true)
    })
    expect(result.current.copiedKey).toBe('first')
    act(() => vi.advanceTimersByTime(500))
    await act(async () => {
      expect(await result.current.copy('second', 'beta')).toBe(true)
    })
    act(() => vi.advanceTimersByTime(999))
    expect(result.current.copiedKey).toBe('second')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.copiedKey).toBeNull()
    expect(writeText).toHaveBeenNthCalledWith(1, 'alpha')
    expect(writeText).toHaveBeenNthCalledWith(2, 'beta')

    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    await act(async () => {
      expect(await result.current.copy('failure', 'secret')).toBe(false)
    })
    expect(result.current.copiedKey).toBeNull()
    unmount()
  })

  it('clears an outstanding copy timer when unmounted', async () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const { result, unmount } = renderHook(() => useCopyFeedback())
    await act(async () => {
      await result.current.copy('row', 'value')
    })
    unmount()
    expect(clear).toHaveBeenCalled()
  })

  it('uses inert and provided lifecycle/runtime contexts deliberately', async () => {
    const proceed = vi.fn()
    const fallback = renderHook(() => useProjectLifecycle())
    fallback.result.current.requestBoundary('new-project', proceed)
    await waitFor(() => expect(proceed).toHaveBeenCalledOnce())

    const requestBoundary = vi.fn()
    const lifecycleWrapper = ({ children }: { children: ReactNode }) => (
      <ProjectLifecycleContext.Provider value={{ requestBoundary }}>
        {children}
      </ProjectLifecycleContext.Provider>
    )
    const provided = renderHook(() => useProjectLifecycle(), {
      wrapper: lifecycleWrapper,
    })
    provided.result.current.requestBoundary('open-project', proceed)
    expect(requestBoundary).toHaveBeenCalledWith('open-project', proceed)

    expect(renderHook(() => useRuntime()).result.current).toMatchObject({
      runs: [],
      jobs: [],
      activeCount: 0,
    })
    const runtime: RuntimeState = {
      runs: [],
      jobs: [],
      logs: [],
      logReplay: logReplayCoverage(null),
      provision: null,
      summary: null,
      hydrating: true,
      error: 'fixture',
      authoritativeRuntimeKnown: true,
      authorityState: 'known',
      retryHydration: vi.fn(),
      activeRuns: [],
      activeJobs: [],
      activeCount: 2,
    }
    const runtimeWrapper = ({ children }: { children: ReactNode }) => (
      <RuntimeContext.Provider value={runtime}>
        {children}
      </RuntimeContext.Provider>
    )
    expect(
      renderHook(() => useRuntime(), { wrapper: runtimeWrapper }).result
        .current,
    ).toBe(runtime)
  })

  it('distinguishes a native bridge from the installed browser mock', () => {
    delete window.supraspina
    expect(getApi()).toBe(window.supraspina)
    expect(hasNativeBridge()).toBe(false)

    const native = createMockApi() as SupraspinaApi & { __mock?: true }
    delete native.__mock
    window.supraspina = native
    expect(getApi()).toBe(native)
    expect(hasNativeBridge()).toBe(true)
  })
})
