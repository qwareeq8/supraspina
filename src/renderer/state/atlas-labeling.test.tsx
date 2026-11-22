// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupraspinaApi } from '../../shared/contract'
import type { AnalysisStageCurrency } from '../../shared/group-analysis'
import type { ProjectRef } from '../../shared/types'
import { createMockApi } from '../ipc/mock'
import { MOCK_LABEL_POLLS } from '../ipc/mock-analysis-v2'
import {
  DOWNLOAD_POLL_MS,
  LABEL_POLL_MS,
  useAtlasLabeling,
} from './atlas-labeling'

const A: ProjectRef = {
  projectId: 'a',
  root: '/projects/a',
  configPath: '/projects/a/supraspina.project.json',
  epoch: 1,
}
const B: ProjectRef = { ...A, projectId: 'b', root: '/projects/b', epoch: 2 }

const CURRENT: AnalysisStageCurrency = {
  aggregate: 'current',
  pybrainage: 'current',
  recon: { state: 'outdated', outdatedSubjectIds: ['sub-002'] },
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mount(
  api: SupraspinaApi = createMockApi(),
  project: ProjectRef | null = A,
  stageCurrency: AnalysisStageCurrency = CURRENT,
) {
  window.supraspina = api
  const onChanged = vi.fn()
  return {
    api,
    onChanged,
    ...renderHook(
      (props: {
        project: ProjectRef | null
        stageCurrency: AnalysisStageCurrency
      }) =>
        useAtlasLabeling(props.project, {
          stageCurrency: props.stageCurrency,
          onChanged,
        }),
      { initialProps: { project, stageCurrency } },
    ),
  }
}

describe('useAtlasLabeling', () => {
  it('reads the atlases with the out-of-date recons and again when they change', async () => {
    const api = createMockApi()
    const atlases = vi.spyOn(api.groupAnalysis, 'atlases')
    const { result, rerender } = mount(api)
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    await waitFor(() => expect(result.current.sources.phase).toBe('ready'))
    expect(atlases).toHaveBeenCalledWith({
      project: A,
      reconOutdatedSubjectIds: ['sub-002'],
    })
    const catalog = result.current.catalog
    expect(
      catalog.phase === 'ready' &&
        catalog.value.atlases.find((a) => a.atlasId === 'brainstem-ss')!.counts
          .reconOutdated,
    ).toBe(2)
    rerender({
      project: A,
      stageCurrency: {
        ...CURRENT,
        recon: { state: 'current', outdatedSubjectIds: [] },
      },
    })
    await waitFor(() =>
      expect(atlases).toHaveBeenLastCalledWith({
        project: A,
        reconOutdatedSubjectIds: [],
      }),
    )
    // The same list in a new object reads nothing again.
    const calls = atlases.mock.calls.length
    rerender({
      project: A,
      stageCurrency: {
        ...CURRENT,
        recon: { state: 'current', outdatedSubjectIds: [] },
      },
    })
    expect(atlases.mock.calls.length).toBe(calls)
  })

  it('drops the previous project state at once on a switch', async () => {
    const { result, rerender } = mount()
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    rerender({ project: B, stageCurrency: CURRENT })
    expect(result.current.catalog.phase).toBe('loading')
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    rerender({ project: null, stageCurrency: CURRENT })
    expect(result.current.catalog.phase).toBe('loading')
  })

  it('polls a labeling every second until it ends, then reads again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = createMockApi()
    const status = vi.spyOn(api.groupAnalysis, 'labelStatus')
    const { result, onChanged } = mount(api)
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    act(() => result.current.readSubjects('brainstem-ss'))
    await waitFor(() =>
      expect(result.current.subjects?.load.phase).toBe('ready'),
    )
    let started = false
    await act(async () => {
      started = await result.current.start('brainstem-ss', 'missing', 2)
    })
    expect(started).toBe(true)
    expect(result.current.labelingRunning).toBe(true)
    for (let poll = 0; poll < MOCK_LABEL_POLLS; poll += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LABEL_POLL_MS)
      })
    }
    await waitFor(() => expect(result.current.labeling?.state).toBe('done'))
    expect(onChanged).toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith({ project: A, atlasId: 'brainstem-ss' })
    const polls = status.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LABEL_POLL_MS * 3)
    })
    expect(status.mock.calls.length).toBe(polls)
    // The catalog carries the finished operation.
    await waitFor(() =>
      expect(
        result.current.catalog.phase === 'ready' &&
          result.current.catalog.value.labeling?.state,
      ).toBe('done'),
    )
  })

  it('cancels a labeling and reports a refused start as a fact', async () => {
    const api = createMockApi()
    const { result, onChanged } = mount(api)
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    await act(async () => {
      await result.current.start('thalamic', ['sub-001'], 1)
    })
    await act(async () => {
      await result.current.cancel()
    })
    expect(result.current.labeling?.state).toBe('cancelled')
    expect(onChanged).toHaveBeenCalled()
    // Cancel without a running labeling does nothing.
    await act(async () => {
      await result.current.cancel()
    })
    api.groupAnalysis.labelStart = async () => {
      throw new Error('Choose 1 to 8 parallel labeling jobs.')
    }
    let started = true
    await act(async () => {
      started = await result.current.start('thalamic', 'missing', 9)
    })
    expect(started).toBe(false)
    expect(result.current.actionError).toBe(
      'Choose 1 to 8 parallel labeling jobs.',
    )
    expect(result.current.busy).toBe(false)
    act(() => result.current.dismissError())
    expect(result.current.actionError).toBeNull()
  })

  it('clears labels at the catalog revision and imports labels and atlases', async () => {
    const api = createMockApi()
    const clear = vi.spyOn(api.groupAnalysis, 'clearLabels')
    const { result, onChanged } = mount(api)
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    let cleared = false
    await act(async () => {
      cleared = await result.current.clear('brainstem-ss', 'all')
    })
    expect(cleared).toBe(true)
    expect(clear).toHaveBeenCalledWith({
      project: A,
      atlasId: 'brainstem-ss',
      subjects: 'all',
      expectedRevision: 3,
    })
    // A second clear at the old revision is refused by the store.
    await waitFor(() =>
      expect(
        result.current.catalog.phase === 'ready' &&
          result.current.catalog.value.revision,
      ).toBe(4),
    )
    let imported = null as Awaited<
      ReturnType<typeof result.current.importLabels>
    >
    await act(async () => {
      imported = await result.current.importLabels('brainstem-ss')
    })
    expect(imported).toMatchObject({ imported: 4 })
    let atlas = null as Awaited<ReturnType<typeof result.current.addAtlas>>
    await act(async () => {
      atlas = await result.current.addAtlas({
        recipeId: 'user-annot',
        label: 'Lab parcels',
        license: { name: 'CC BY 4.0', url: null },
        externalSourceId: null,
      })
    })
    expect(atlas).toMatchObject({ label: 'Lab parcels', origin: 'added' })
    expect(onChanged).toHaveBeenCalledTimes(3)
    await waitFor(() =>
      expect(
        result.current.catalog.phase === 'ready' &&
          result.current.catalog.value.atlases.some(
            (entry) => entry.label === 'Lab parcels',
          ),
      ).toBe(true),
    )
  })

  it('downloads a source, polls it to the end, and cancels another', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = createMockApi()
    const { result, onChanged } = mount(api)
    await waitFor(() => expect(result.current.sources.phase).toBe('ready'))
    await act(async () => {
      await result.current.startDownload('schaefer2018')
    })
    expect(result.current.download?.state).toBe('running')
    for (let poll = 0; poll < 4; poll += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DOWNLOAD_POLL_MS)
      })
    }
    await waitFor(() => expect(result.current.download?.state).toBe('done'))
    expect(onChanged).toHaveBeenCalled()
    await waitFor(() =>
      expect(
        result.current.sources.phase === 'ready' &&
          result.current.sources.value.sources.find(
            (item) => item.source.sourceId === 'schaefer2018',
          )!.state,
      ).toBe('present'),
    )
    let failed = true
    await act(async () => {
      failed = await result.current.startDownload('brainnetome')
    })
    expect(failed).toBe(false)
    expect(result.current.actionError).toBe(
      'This source has no verified download; open its page.',
    )
  })

  it('chooses and clears the subregions Python and opens pages', async () => {
    const api = createMockApi()
    const { result } = mount(api)
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    await act(async () => {
      await result.current.chooseSubregionsPython()
    })
    await waitFor(() =>
      expect(
        result.current.catalog.phase === 'ready' &&
          result.current.catalog.value.subregionsPython,
      ).toBe('/opt/py312/bin/python'),
    )
    await act(async () => {
      await result.current.clearSubregionsPython()
    })
    await waitFor(() =>
      expect(
        result.current.catalog.phase === 'ready' &&
          result.current.catalog.value.subregionsPython,
      ).toBeNull(),
    )
    api.atlasSources.openPage = async () => {
      throw new Error('Open only an allowlisted atlas page.')
    }
    const open = vi.spyOn(api.atlasSources, 'openPage')
    await act(async () => {
      await result.current.openPage('elsewhere')
    })
    expect(open).toHaveBeenLastCalledWith({
      sourceId: 'elsewhere',
      kind: 'page',
    })
    expect(result.current.actionError).toBe(
      'Open only an allowlisted atlas page.',
    )
    expect(result.current.busy).toBe(false)
  })

  it('reports unreadable atlases, sources, and label states as facts', async () => {
    const api = createMockApi()
    api.groupAnalysis.atlases = async () => {
      throw new Error('The workflow service lacks atlas labeling.')
    }
    api.atlasSources.list = async () => {
      throw new Error('')
    }
    api.groupAnalysis.labelStatus = async () => {
      throw new Error('The label states could not be read.')
    }
    const { result } = mount(api)
    await waitFor(() => expect(result.current.catalog.phase).toBe('error'))
    await waitFor(() => expect(result.current.sources.phase).toBe('error'))
    const sources = result.current.sources
    expect(sources.phase === 'error' && sources.message).toBe(
      'The atlas sources could not be read.',
    )
    act(() => result.current.readSubjects('brainstem-ss'))
    await waitFor(() =>
      expect(result.current.subjects?.load.phase).toBe('error'),
    )
    // Clearing needs the catalog revision.
    let cleared = true
    await act(async () => {
      cleared = await result.current.clear('brainstem-ss', 'all')
    })
    expect(cleared).toBe(false)
  })
})
