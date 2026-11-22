// @vitest-environment jsdom
/** Tests for the term rows and details of a shown v2 result. */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GroupAnalysisResultV2,
  GroupAnalysisTermRows,
} from '../../shared/group-analysis'
import type { ProjectRef } from '../../shared/types'
import { createMockApi } from '../ipc/mock'
import {
  MOCK_BATTERY_RESULT,
  MOCK_OMNIBUS_RESULT,
  mockTermRows,
} from '../ipc/mock-analysis-v2'
import { useAnalysisTerms } from './analysis-terms'

const PROJECT: ProjectRef = {
  projectId: 'p',
  root: '/p',
  configPath: '/p/supraspina.project.json',
  epoch: 1,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAnalysisTerms', () => {
  it('seeds the first term from the header and reads others on demand', async () => {
    const api = createMockApi()
    const termRows = vi.spyOn(api.groupAnalysis, 'termRows')
    window.supraspina = api
    const { result } = renderHook(() =>
      useAnalysisTerms(PROJECT, MOCK_OMNIBUS_RESULT),
    )
    expect(result.current.termRows('term-1')).toMatchObject({
      rows: MOCK_OMNIBUS_RESULT.rows,
      total: 3,
      nextOffset: null,
    })
    expect(result.current.termRows('term-2')).toMatchObject({
      rows: [],
      nextOffset: 0,
    })
    expect(result.current.termRows('term-9')).toBeNull()
    act(() => result.current.ensure(['term-1', 'term-2']))
    await waitFor(() =>
      expect(result.current.termRows('term-2')?.rows).toHaveLength(3),
    )
    expect(termRows).toHaveBeenCalledTimes(1)
    expect(termRows).toHaveBeenCalledWith(
      expect.objectContaining({ termId: 'term-2', offset: 0 }),
    )
    // A read term is not read again.
    act(() => result.current.ensure(['term-2']))
    expect(termRows).toHaveBeenCalledTimes(1)
  })

  it('reports a failed page and reads it again on request', async () => {
    const api = createMockApi()
    let fail = true
    api.groupAnalysis.termRows = vi.fn(async ({ resultId, termId, offset }) => {
      if (fail) throw new Error('The workflow service is not ready.')
      return mockTermRows(resultId, termId, offset)
    })
    window.supraspina = api
    const { result } = renderHook(() =>
      useAnalysisTerms(PROJECT, MOCK_OMNIBUS_RESULT),
    )
    act(() => result.current.readMore(['term-3']))
    await waitFor(() =>
      expect(result.current.termRows('term-3')?.error).toBe(
        'The workflow service is not ready.',
      ),
    )
    fail = false
    act(() => result.current.readMore(['term-3']))
    await waitFor(() =>
      expect(result.current.termRows('term-3')?.rows).toHaveLength(3),
    )
    expect(result.current.termRows('term-3')?.error).toBeNull()
  })

  it('drops a late page for a result no longer shown', async () => {
    const api = createMockApi()
    let release: (page: GroupAnalysisTermRows) => void = () => undefined
    api.groupAnalysis.termRows = vi.fn(
      () =>
        new Promise<GroupAnalysisTermRows>((resolve) => {
          release = resolve
        }),
    )
    window.supraspina = api
    const { result, rerender } = renderHook(
      ({ shown }: { shown: GroupAnalysisResultV2 }) =>
        useAnalysisTerms(PROJECT, shown),
      { initialProps: { shown: MOCK_OMNIBUS_RESULT } },
    )
    act(() => result.current.ensure(['term-2']))
    rerender({ shown: MOCK_BATTERY_RESULT })
    await act(async () => {
      release(mockTermRows(MOCK_OMNIBUS_RESULT.resultId, 'term-2', 0))
    })
    expect(result.current.termRows('term-2')?.rows).toEqual([])
    expect(result.current.termRows('term-1')?.rows).toEqual(
      MOCK_BATTERY_RESULT.rows,
    )
  })

  it('reads a measure detail per term once', async () => {
    const api = createMockApi()
    const detail = vi.spyOn(api.groupAnalysis, 'measureDetail')
    window.supraspina = api
    const { result } = renderHook(() =>
      useAnalysisTerms(PROJECT, MOCK_OMNIBUS_RESULT),
    )
    act(() => result.current.requestDetail('term-2', 'aseg:Brain-Stem'))
    act(() => result.current.requestDetail('term-2', 'aseg:Brain-Stem'))
    await waitFor(() =>
      expect(result.current.detail('term-2', 'aseg:Brain-Stem')?.phase).toBe(
        'ready',
      ),
    )
    expect(detail).toHaveBeenCalledTimes(1)
    expect(result.current.detail('term-3', 'aseg:Brain-Stem')).toBeNull()
  })
})
