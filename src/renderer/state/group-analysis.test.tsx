// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunSnapshot } from '../../shared/contract'
import {
  upgradeGroupAnalysisSpecV1,
  validateGroupAnalysisSpec,
  validateGroupAnalysisSpecV2,
} from '../../shared/group-analysis'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectRef, Subject } from '../../shared/types'
import { createMockApi } from '../ipc/mock'
import {
  MOCK_BATTERY_SPEC,
  MOCK_OMNIBUS_RESULT,
  MOCK_VARIABLE_TABLE,
} from '../ipc/mock-analysis-v2'
import {
  MOCK_ANALYSIS_RESULT,
  MOCK_ANALYSIS_SPEC,
  mockAnalysisCatalog,
} from '../ipc/mock-group-analysis'
import {
  ANALYSIS_POLL_MS,
  analysisProjectKey,
  analysisRejudgeKey,
  analysisDraft,
  analysisStageCurrency,
  defaultAnalysisSpec,
  defaultAnalysisSpecV2,
  parseSetCsv,
  proposeGroups,
  setNameFromFile,
  useGroupAnalysis,
} from './group-analysis'

const A: ProjectRef = {
  projectId: 'a',
  root: '/projects/a',
  configPath: '/projects/a/supraspina.project.json',
  epoch: 1,
}
const B: ProjectRef = { ...A, projectId: 'b', root: '/projects/b', epoch: 2 }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('helpers', () => {
  it('reads measure IDs from the first CSV column', () => {
    expect(
      parseSetCsv(
        'measure,note\n"aseg:Brain-Stem",a priori\ndk:bi:precentral:ThickAvg;x\naseg:Brain-Stem\nnot-a-measure\n\n',
      ),
    ).toEqual({
      measures: ['aseg:Brain-Stem', 'dk:bi:precentral:ThickAvg'],
      invalid: ['not-a-measure'],
    })
    expect(setNameFromFile('a-priori set.csv')).toBe('a-priori set')
    expect(setNameFromFile('\u00e9.csv')).toBe('Imported set')
  })

  it('proposes a control reference and merges the other levels by prefix', () => {
    const variable = mockAnalysisCatalog().variables.find(
      (v) => v.ref.column === 'sourceCohortLabel',
    )!
    expect(proposeGroups(variable)).toEqual({
      groups: [
        { label: 'SCI', levels: ['SCI_nNP', 'SCI_P'] },
        { label: 'CTRL', levels: ['CTRL'] },
      ],
      focal: 'SCI',
      reference: 'CTRL',
    })
    expect(
      proposeGroups({
        levels: [
          { value: 'drug', n: 2 },
          { value: 'placebo', n: 2 },
        ],
      }),
    ).toMatchObject({ focal: 'placebo', reference: 'drug' })
  })

  it('names the proposed groups readably, never by a truncated prefix', () => {
    const roles = mockAnalysisCatalog().variables.find(
      (v) => v.ref.column === 'cohortRole',
    )!
    expect(proposeGroups(roles)).toEqual({
      groups: [
        {
          label: 'SCI',
          levels: ['sci-neuropathic-pain', 'sci-no-neuropathic-pain'],
        },
        { label: 'CTRL', levels: ['healthy'] },
      ],
      focal: 'SCI',
      reference: 'CTRL',
    })
    const levels = (...values: string[]) => ({
      levels: values.map((value) => ({ value, n: 1 })),
    })
    // An uppercase control code keeps its own name.
    expect(proposeGroups(levels('HC', 'MS-a', 'MS-b'))).toMatchObject({
      focal: 'MS',
      reference: 'HC',
    })
    expect(
      proposeGroups(levels('control', 'patient.early', 'patient.late')),
    ).toMatchObject({ focal: 'Patient', reference: 'CTRL' })
    // No whole shared token: name the first level and the rest.
    expect(proposeGroups(levels('healthy', 'abc', 'abd'))).toMatchObject({
      focal: 'abc and others',
      reference: 'CTRL',
    })
    expect(proposeGroups(levels('healthy'))).toEqual({
      groups: [{ label: 'CTRL', levels: ['healthy'] }],
      focal: 'CTRL',
      reference: 'CTRL',
    })
  })

  it('builds a valid default specification with a recorded seed', () => {
    const spec = defaultAnalysisSpec(mockAnalysisCatalog(), 12345)
    expect(validateGroupAnalysisSpec(spec).ok).toBe(true)
    expect(spec.measures).toHaveLength(34)
    expect(
      spec.measures.every((id) => /^dk:bi:[a-z]+:ThickAvg$/.test(id)),
    ).toBe(true)
    expect(spec.inclusion).toEqual({
      qc: 'non-failed',
      registration: 'set-missing',
      outliers: 'keep',
    })
    expect(spec.covariates.etiv).toBe('extensive')
    expect(spec.inference).toMatchObject({ permutations: 5000, seed: 12345 })
  })

  it('drafts in spec v2: the v1 default and stored v1 specifications upgraded', () => {
    const spec = defaultAnalysisSpecV2(mockAnalysisCatalog(), 12345)
    expect(validateGroupAnalysisSpecV2(spec).ok).toBe(true)
    expect(spec.design).toEqual({
      scope: 'between',
      population: null,
      subset: [],
    })
    expect(spec.tests).toHaveLength(1)
    expect(spec.tests[0]).toMatchObject({
      kind: 'two-group',
      label: 'SCI vs CTRL',
    })
    expect(spec.inclusion.minCellN).toBe(3)
    expect(spec.covariates.headSize).toEqual({
      source: 'etiv',
      rule: 'extensive',
    })
    expect(analysisDraft(MOCK_ANALYSIS_SPEC)).toEqual(
      upgradeGroupAnalysisSpecV1(MOCK_ANALYSIS_SPEC),
    )
    expect(analysisDraft(MOCK_BATTERY_SPEC)).toBe(MOCK_BATTERY_SPEC)
  })

  it('maps the stage currency read to the input stages and recons', () => {
    expect(
      analysisStageCurrency({
        checked: true,
        stageCurrency: {
          aggregate: { state: 'outdated', outdatedSubjectIds: [] },
          recon: { state: 'outdated', outdatedSubjectIds: ['sub-002'] },
        },
      }),
    ).toEqual({
      aggregate: 'outdated',
      pybrainage: 'unknown',
      recon: { state: 'outdated', outdatedSubjectIds: ['sub-002'] },
    })
    expect(
      analysisStageCurrency({
        checked: false,
        stageCurrency: {
          aggregate: { state: 'current', outdatedSubjectIds: [] },
          recon: { state: 'outdated', outdatedSubjectIds: ['sub-002'] },
        },
      }),
    ).toEqual({
      aggregate: 'unknown',
      pybrainage: 'unknown',
      recon: { state: 'unknown', outdatedSubjectIds: [] },
    })
    const many = Array.from({ length: 5001 }, (_, i) => `sub-${i}`)
    expect(
      analysisStageCurrency({
        checked: true,
        stageCurrency: {
          recon: { state: 'outdated', outdatedSubjectIds: many },
        },
      }).recon?.outdatedSubjectIds,
    ).toHaveLength(5000)
  })

  it('keys every rejudge trigger and nothing else', () => {
    const subject = {
      id: 'sub-001',
      qc: null,
      qcRevision: 1,
    } as unknown as Subject
    const run = { runId: 'r1', endedAt: null } as unknown as RunSnapshot
    const base = analysisRejudgeKey([subject], [run], DEFAULT_PROJECT_CONFIG)
    expect(
      analysisRejudgeKey(
        [{ ...subject, qc: 'fail' }],
        [run],
        DEFAULT_PROJECT_CONFIG,
      ),
    ).not.toBe(base)
    expect(
      analysisRejudgeKey(
        [subject],
        [{ ...run, endedAt: 5 } as RunSnapshot],
        DEFAULT_PROJECT_CONFIG,
      ),
    ).not.toBe(base)
    expect(
      analysisRejudgeKey([subject], [run], {
        ...DEFAULT_PROJECT_CONFIG,
        subjects: { ...DEFAULT_PROJECT_CONFIG.subjects, exclude: ['sub-001'] },
      }),
    ).not.toBe(base)
    expect(
      analysisRejudgeKey(
        [{ ...subject, notes: 'x' }],
        [run],
        DEFAULT_PROJECT_CONFIG,
      ),
    ).toBe(base)
    expect(analysisProjectKey(null)).toBeNull()
    expect(analysisProjectKey(A)).toBe('["a","/projects/a",1]')
  })
})

describe('useGroupAnalysis', () => {
  function mount(
    api = createMockApi(),
    project: ProjectRef | null = A,
    rejudgeKey = 'k',
  ) {
    window.supraspina = api
    return {
      api,
      ...renderHook(
        (props: { project: ProjectRef | null; rejudgeKey: string }) =>
          useGroupAnalysis(props.project, { rejudgeKey: props.rejudgeKey }),
        { initialProps: { project, rejudgeKey } },
      ),
    }
  }

  it('loads the catalog, list, result, and the result specification as draft', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.result?.phase).toBe('ready'))
    expect(result.current.resultId).toBe(MOCK_ANALYSIS_RESULT.resultId)
    await waitFor(() =>
      expect(result.current.draft).toEqual(
        upgradeGroupAnalysisSpecV1(MOCK_ANALYSIS_SPEC),
      ),
    )
    expect(result.current.draftSource.name).toBe('SCI vs controls')
    expect(result.current.draftChanged).toBe(false)
    await waitFor(() => expect(result.current.inputs?.phase).toBe('ready'))
  })

  it('drops the previous project state at once on a switch', async () => {
    const { result, rerender } = mount()
    await waitFor(() => expect(result.current.result?.phase).toBe('ready'))
    rerender({ project: B, rejudgeKey: 'k' })
    expect(result.current.list.phase).toBe('loading')
    expect(result.current.result).toBeNull()
    expect(result.current.draft).toBeNull()
    await waitFor(() => expect(result.current.result?.phase).toBe('ready'))
  })

  it('reads the list again when the rejudge key changes or the window regains focus', async () => {
    const { api, result, rerender } = mount()
    const list = vi.spyOn(api.groupAnalysis, 'list')
    await waitFor(() => expect(result.current.list.phase).toBe('ready'))
    const before = list.mock.calls.length
    rerender({ project: A, rejudgeKey: 'k2' })
    await waitFor(() => expect(list.mock.calls.length).toBe(before + 1))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(list.mock.calls.length).toBe(before + 2))
  })

  it('reads the catalog again on a rejudge and keeps it when a reread fails', async () => {
    const { api, result, rerender } = mount()
    const catalog = vi.spyOn(api.groupAnalysis, 'catalog')
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    const before = catalog.mock.calls.length
    catalog.mockRejectedValueOnce(new Error('The workflow service restarted.'))
    rerender({ project: A, rejudgeKey: 'k2' })
    await waitFor(() => expect(catalog.mock.calls.length).toBe(before + 1))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.catalog.phase).toBe('ready')
    rerender({ project: A, rejudgeKey: 'k3' })
    await waitFor(() => expect(catalog.mock.calls.length).toBe(before + 2))
  })

  it('keeps the newest list when an older read answers last', async () => {
    const api = createMockApi()
    const original = api.groupAnalysis.list
    const pending: ((value: Awaited<ReturnType<typeof original>>) => void)[] =
      []
    const { result, rerender } = mount(api)
    await waitFor(() => expect(result.current.list.phase).toBe('ready'))
    const base = await original({ project: A })
    api.groupAnalysis.list = () =>
      new Promise((resolve) => {
        pending.push(resolve)
      })
    rerender({ project: A, rejudgeKey: 'k2' })
    await waitFor(() => expect(pending).toHaveLength(1))
    rerender({ project: A, rejudgeKey: 'k3' })
    await waitFor(() => expect(pending).toHaveLength(2))
    act(() => pending[1]!({ ...base, revision: base.revision + 5 }))
    await waitFor(() => {
      const list = result.current.list
      expect(list.phase === 'ready' && list.value.revision).toBe(
        base.revision + 5,
      )
    })
    act(() => pending[0]!({ ...base, revision: base.revision + 1 }))
    await act(async () => {
      await Promise.resolve()
    })
    const list = result.current.list
    expect(list.phase === 'ready' && list.value.revision).toBe(
      base.revision + 5,
    )
  })

  it('polls every 500 ms only while the compute runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { api, result } = mount()
    const status = vi.spyOn(api.groupAnalysis, 'status')
    await waitFor(() => expect(result.current.draft).not.toBeNull())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANALYSIS_POLL_MS * 3)
    })
    expect(status).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.compute({
        aggregate: 'current',
        pybrainage: 'current',
      })
    })
    expect(result.current.running).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANALYSIS_POLL_MS * 6)
    })
    expect(result.current.running).toBe(false)
    expect(result.current.operation?.state).toBe('done')
    const calls = status.mock.calls.length
    expect(calls).toBe(4)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ANALYSIS_POLL_MS * 4)
    })
    expect(status.mock.calls.length).toBe(calls)
  })

  it('stops polling once a cancel lands', async () => {
    const { api, result } = mount()
    await waitFor(() => expect(result.current.draft).not.toBeNull())
    await act(async () => {
      await result.current.compute({
        aggregate: 'current',
        pybrainage: 'current',
      })
    })
    const cancel = vi.spyOn(api.groupAnalysis, 'cancel')
    await act(async () => {
      await result.current.cancel()
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(result.current.operation?.state).toBe('cancelled')
    expect(result.current.running).toBe(false)
  })

  it('reads a v2 result for the v2 view and drafts from its spec', async () => {
    const api = createMockApi()
    api.groupAnalysis.result = async () => MOCK_OMNIBUS_RESULT
    const { result } = mount(api)
    await waitFor(() => expect(result.current.result?.phase).toBe('ready'))
    expect(
      result.current.result?.phase === 'ready' &&
        result.current.result.value.schemaVersion,
    ).toBe(2)
    await waitFor(() => expect(result.current.draft).not.toBeNull())
    // The v2 rail takes a v2 result's spec as its draft unchanged.
    expect(result.current.draft).toEqual(MOCK_OMNIBUS_RESULT.spec)
    expect(result.current.draftChanged).toBe(false)
  })

  it('keeps the shown result when it is chosen again', async () => {
    const api = createMockApi()
    const read = vi.spyOn(api.groupAnalysis, 'result')
    const { result } = mount(api)
    await waitFor(() => expect(result.current.result?.phase).toBe('ready'))
    const calls = read.mock.calls.length
    act(() => result.current.selectResult(result.current.resultId!))
    expect(result.current.result?.phase).toBe('ready')
    expect(read.mock.calls.length).toBe(calls)
  })

  it('reports a failed start and keeps the draft', async () => {
    const api = createMockApi()
    api.groupAnalysis.start = async () => {
      throw new Error('The workflow service is not ready.')
    }
    const { result } = mount(api)
    await waitFor(() => expect(result.current.draft).not.toBeNull())
    await act(async () => {
      await result.current.compute({
        aggregate: 'current',
        pybrainage: 'current',
      })
    })
    expect(result.current.actionError).toBe(
      'The workflow service is not ready.',
    )
    act(() => result.current.dismissError())
    expect(result.current.actionError).toBeNull()
  })

  it('refuses to change a locked set and saves an imported one', async () => {
    const api = createMockApi()
    api.groupAnalysis.chooseSetCsv = async () => ({
      name: 'motor.csv',
      displayPath: '/tmp/motor.csv',
      text: 'aseg:Brain-Stem\nnonsense\n',
    })
    const { result } = mount(api)
    await waitFor(() => expect(result.current.list.phase).toBe('ready'))
    const list = result.current.list
    const locked = list.phase === 'ready' ? list.value.sets[0]! : null
    let saved: unknown
    await act(async () => {
      saved = await result.current.saveSet(locked!.setId, locked!.name, [
        'aseg:Brain-Stem',
      ])
    })
    expect(saved).toBeNull()
    expect(result.current.actionError).toBe('Copy the locked set to change it.')
    let imported: Awaited<ReturnType<typeof result.current.importSet>> = null
    await act(async () => {
      imported = await result.current.importSet()
    })
    expect(imported).toMatchObject({
      set: { name: 'motor', measures: ['aseg:Brain-Stem'], locked: null },
      invalid: ['nonsense'],
    })
    await act(async () => {
      await result.current.lockSet(imported!.set.setId)
    })
    const after = result.current.list
    expect(
      after.phase === 'ready' &&
        after.value.sets.find((s) => s.name === 'motor')?.locked,
    ).toBeTruthy()
  })

  it('saves the draft under a name and loads a saved specification', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.draft).not.toBeNull())
    act(() =>
      result.current.setDraft({
        ...result.current.draft!,
        inference: { ...result.current.draft!.inference, alpha: 0.01 },
      }),
    )
    expect(result.current.draftChanged).toBe(true)
    await act(async () => {
      await result.current.saveSpec('Strict alpha')
    })
    expect(result.current.draftSource.name).toBe('Strict alpha')
    const list = result.current.list
    const original =
      list.phase === 'ready'
        ? list.value.specs.find((s) => s.name === 'SCI vs controls')!
        : null
    act(() => result.current.loadSavedSpec(original!.specId))
    expect(result.current.draft?.inference.alpha).toBe(0.05)
    await act(async () => {
      await result.current.deleteSpec(original!.specId)
    })
    expect(result.current.draftSource.specId).toBeNull()
  })

  it('imports and removes variables tables and reads the catalog again', async () => {
    const api = createMockApi()
    const catalog = vi.spyOn(api.groupAnalysis, 'catalog')
    const { result } = mount(api)
    await waitFor(() => expect(result.current.catalog.phase).toBe('ready'))
    const reads = catalog.mock.calls.length
    let removed = false
    await act(async () => {
      removed = await result.current.removeVariables(
        MOCK_VARIABLE_TABLE.tableId,
      )
    })
    expect(removed).toBe(true)
    await waitFor(() => expect(catalog.mock.calls.length).toBe(reads + 1))
    await waitFor(() =>
      expect(
        result.current.catalog.phase === 'ready' &&
          result.current.catalog.value.variableTables,
      ).toEqual([]),
    )
    let table = null as Awaited<
      ReturnType<typeof result.current.importVariables>
    >
    await act(async () => {
      table = await result.current.importVariables()
    })
    expect(table?.name).toBe('clinical-variables.csv')
    act(() => result.current.rereadCatalog())
    await waitFor(() => expect(catalog.mock.calls.length).toBe(reads + 3))
    api.groupAnalysis.chooseVariablesCsv = async () => {
      throw new Error('Choose a CSV of at most 2 MiB.')
    }
    await act(async () => {
      await result.current.importVariables()
    })
    expect(result.current.actionError).toBe('Choose a CSV of at most 2 MiB.')
    api.groupAnalysis.removeVariables = async () => {
      throw new Error('')
    }
    await act(async () => {
      await result.current.removeVariables('var-0000000000000000')
    })
    expect(result.current.actionError).toBe(
      'The variables table could not be removed.',
    )
  })

  it('loads a saved spec v2 as the draft unchanged', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.list.phase).toBe('ready'))
    act(() => result.current.setDraft(MOCK_BATTERY_SPEC))
    await act(async () => {
      await result.current.saveSpec('Battery')
    })
    act(() => result.current.resetDraft())
    expect(result.current.draft?.design.scope).toBe('between')
    const list = result.current.list
    const saved =
      list.phase === 'ready'
        ? list.value.specs.find((spec) => spec.name === 'Battery')!
        : null
    act(() => result.current.loadSavedSpec(saved!.specId))
    expect(result.current.draft).toEqual(MOCK_BATTERY_SPEC)
    expect(result.current.draftErrors).toEqual([])
  })
})
