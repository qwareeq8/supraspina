import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { useLayoutEffect, type ReactNode } from 'react'
import type { ResultPage } from '../../shared/contract'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectRef } from '../../shared/types'
import { createMockApi } from '../ipc/mock'
import { AppProvider, useApp } from './context'
import {
  logReplayCoverage,
  RuntimeContext,
  type RuntimeState,
} from './runtime-state'
import {
  cohortConfigKey,
  useProjectStageCurrency,
  useStageCurrency,
  type StageCurrencyOptions,
} from './stage-currency'
import { StageCurrencyProvider } from './stage-currency-context'

const PROJECT_A: ProjectRef = {
  projectId: 'project-a',
  root: '/projects/a',
  configPath: '/projects/a/supraspina.project.json',
  epoch: 1,
}

const PROJECT_B: ProjectRef = {
  projectId: 'project-b',
  root: '/projects/b',
  configPath: '/projects/b/supraspina.project.json',
  epoch: 2,
}

/** A results page whose only currency fact is one out-of-date stage. */
function outdatedPage(stepKey: 'enigma' | 'final'): ResultPage {
  return {
    items: [],
    nextCursor: null,
    truncated: false,
    stageCurrency: {
      [stepKey]: {
        state: 'outdated',
        outdatedSubjectIds: [],
        cause: 'analysis-cohort',
      },
    },
    analysisCohortChange: { cause: 'membership' },
  }
}

/** A promise the test settles by hand, to order reads across a switch. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function ProjectBootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  useLayoutEffect(() => {
    if (!app.projectRef) {
      app.markProjectCreated({
        project: PROJECT_A,
        cfg: {
          ...DEFAULT_PROJECT_CONFIG,
          paths: {
            ...DEFAULT_PROJECT_CONFIG.paths,
            projectRoot: PROJECT_A.root,
          },
        },
        configSha256: '0'.repeat(64),
      })
    }
  }, [app])
  return app.projectRef ? children : null
}

/** Show the out-of-date stages one consumer reads. */
function CurrencyProbe({ name }: { name: string }): ReactNode {
  const { projectRef } = useApp()
  const currency = useProjectStageCurrency({
    project: projectRef,
    subjects: [],
    runs: [],
  })
  return (
    <output data-testid={name} data-checked={String(currency.checked)}>
      {Object.keys(currency.stageCurrency).join(',')}
    </output>
  )
}

/** A runtime projection in one authority state, with no runs or jobs. */
function runtimeIn(
  authorityState: RuntimeState['authorityState'],
  hydrating = false,
): RuntimeState {
  return {
    runs: [],
    jobs: [],
    logs: [],
    logReplay: logReplayCoverage(null),
    provision: null,
    summary: null,
    hydrating,
    error: null,
    authoritativeRuntimeKnown: authorityState === 'known',
    authorityState,
    retryHydration: () => undefined,
    activeRuns: [],
    activeJobs: [],
    activeCount: 0,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as { supraspina?: unknown }).supraspina
})

describe('StageCurrencyProvider', () => {
  it('shares one read between every consumer below it', async () => {
    const api = createMockApi()
    window.supraspina = api
    const list = vi
      .spyOn(api.results, 'list')
      .mockResolvedValue(outdatedPage('enigma'))

    render(
      <AppProvider>
        <ProjectBootstrap>
          <StageCurrencyProvider>
            <CurrencyProbe name="top-bar" />
            <CurrencyProbe name="screen" />
          </StageCurrencyProvider>
        </ProjectBootstrap>
      </AppProvider>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('top-bar')).toHaveTextContent('enigma'),
    )
    expect(screen.getByTestId('screen')).toHaveTextContent('enigma')
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ project: PROJECT_A, limit: 1 }),
    )
  })

  it('reads locally when no provider is mounted', async () => {
    const api = createMockApi()
    window.supraspina = api
    const list = vi
      .spyOn(api.results, 'list')
      .mockResolvedValue(outdatedPage('final'))

    const { result } = renderHook(() =>
      useProjectStageCurrency({ project: PROJECT_A, subjects: [], runs: [] }),
    )

    await waitFor(() =>
      expect(result.current.stageCurrency.final?.state).toBe('outdated'),
    )
    expect(list).toHaveBeenCalledTimes(1)
  })

  it("never shows project A's currency after a switch to project B", async () => {
    const api = createMockApi()
    window.supraspina = api
    const firstA = deferred<ResultPage>()
    const lateA = deferred<ResultPage>()
    const readB = deferred<ResultPage>()
    vi.spyOn(api.results, 'list')
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(lateA.promise)
      .mockReturnValueOnce(readB.promise)

    const { result, rerender } = renderHook(
      (options: StageCurrencyOptions) => useStageCurrency(options),
      {
        initialProps: { project: PROJECT_A, subjects: [], runs: [] },
      },
    )
    await act(async () => firstA.resolve(outdatedPage('enigma')))
    expect(result.current.stageCurrency.enigma?.state).toBe('outdated')

    // A reread of A is still in flight when the operator opens B.
    act(() => result.current.reload())
    rerender({ project: PROJECT_B, subjects: [], runs: [] })
    expect(result.current.stageCurrency).toEqual({})

    // The late read for A lands after the switch and is dropped.
    await act(async () => lateA.resolve(outdatedPage('enigma')))
    expect(result.current.stageCurrency).toEqual({})

    await act(async () => readB.resolve(outdatedPage('final')))
    expect(Object.keys(result.current.stageCurrency)).toEqual(['final'])
  })

  it('reads once the runtime is known, and reports the counts unchecked until then', async () => {
    const api = createMockApi()
    window.supraspina = api
    const read = deferred<ResultPage>()
    const list = vi.spyOn(api.results, 'list').mockReturnValue(read.promise)
    const tree = (runtime: RuntimeState): ReactNode => (
      <AppProvider>
        <ProjectBootstrap>
          <RuntimeContext.Provider value={runtime}>
            <StageCurrencyProvider>
              <CurrencyProbe name="top-bar" />
            </StageCurrencyProvider>
          </RuntimeContext.Provider>
        </ProjectBootstrap>
      </AppProvider>
    )

    // At startup the workflow service is ready before hydration begins; a
    // read then would queue ahead of the bootstrap only to be dropped.
    const { rerender } = render(tree(runtimeIn('pending')))
    const probe = await screen.findByTestId('top-bar')
    rerender(tree(runtimeIn('pending', true)))
    rerender(tree(runtimeIn('unavailable')))
    expect(list).not.toHaveBeenCalled()
    expect(probe).toHaveAttribute('data-checked', 'false')

    rerender(tree(runtimeIn('known')))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    expect(probe).toHaveAttribute('data-checked', 'false')

    await act(async () => read.resolve(outdatedPage('enigma')))
    expect(probe).toHaveAttribute('data-checked', 'true')
    expect(probe).toHaveTextContent('enigma')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps the last read checked while a reread runs, and needs none without a project', async () => {
    const api = createMockApi()
    window.supraspina = api
    const reread = deferred<ResultPage>()
    vi.spyOn(api.results, 'list')
      .mockResolvedValueOnce(outdatedPage('enigma'))
      .mockReturnValueOnce(reread.promise)

    const noProject: StageCurrencyOptions = {
      project: null,
      subjects: [],
      runs: [],
    }
    const { result, rerender } = renderHook(
      (options: StageCurrencyOptions) => useStageCurrency(options),
      { initialProps: noProject },
    )
    expect(result.current.checked).toBe(true)

    rerender({ project: PROJECT_A, subjects: [], runs: [] })
    expect(result.current.checked).toBe(false)
    await waitFor(() => expect(result.current.checked).toBe(true))

    act(() => result.current.reload())
    expect(result.current.checked).toBe(true)
    expect(result.current.stageCurrency.enigma?.state).toBe('outdated')
    await act(async () => reread.resolve(outdatedPage('final')))
    expect(Object.keys(result.current.stageCurrency)).toEqual(['final'])
  })

  it('reads again when the saved subject selection changes', async () => {
    const api = createMockApi()
    window.supraspina = api
    const list = vi
      .spyOn(api.results, 'list')
      .mockResolvedValueOnce({ items: [], nextCursor: null, truncated: false })
      .mockResolvedValueOnce(outdatedPage('enigma'))
    const saved = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: PROJECT_A.root },
    }
    const options = (cfg: typeof saved): StageCurrencyOptions => ({
      project: PROJECT_A,
      subjects: [],
      runs: [],
      configKey: cohortConfigKey(cfg),
    })

    const { result, rerender } = renderHook(
      (props: StageCurrencyOptions) => useStageCurrency(props),
      { initialProps: options(saved) },
    )
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    // Another thread count leaves the analysis cohort alone.
    rerender(options({ ...saved, runtime: { ...saved.runtime, threads: 12 } }))
    expect(list).toHaveBeenCalledTimes(1)

    rerender(
      options({ ...saved, subjects: { include: [], exclude: ['sub-003'] } }),
    )
    await waitFor(() =>
      expect(result.current.stageCurrency.enigma?.state).toBe('outdated'),
    )
    expect(list).toHaveBeenCalledTimes(2)
  })
})
