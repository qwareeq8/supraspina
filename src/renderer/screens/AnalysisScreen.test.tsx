// @vitest-environment jsdom

import axe from 'axe-core'
import { NO_WEBGL2_MESSAGE } from './analysis/BrainView'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { RunSnapshot } from '../../shared/contract'
import type {
  GroupAnalysisList,
  GroupAnalysisResultSummary,
} from '../../shared/group-analysis'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectRef, Subject } from '../../shared/types'
import { createMockApi } from '../ipc/mock'
import {
  MOCK_ANALYSIS_RESULT,
  mockAnalysisCatalog,
} from '../ipc/mock-group-analysis'
import { MOCK_BATTERY_RESULT, mockV2Summary } from '../ipc/mock-analysis-v2'
import { AppProvider, useApp, type AppState } from '../state/context'
import { RuntimeContext, type RuntimeState } from '../state/runtime-state'
import { AnalysisScreen } from './AnalysisScreen'
import { ExportDialog } from './analysis/ExportDialog'

/** The v1 `measureDetail` request (the spy types only the v2 overload). */
type V1DetailRequest = {
  project: ProjectRef
  resultId: string
  measureId: string
}

const PROJECT: ProjectRef = {
  projectId: 'analysis-project',
  root: '/projects/analysis',
  configPath: '/projects/analysis/supraspina.project.json',
  epoch: 1,
}
const OTHER: ProjectRef = {
  projectId: 'other-project',
  root: '/projects/other',
  configPath: '/projects/other/supraspina.project.json',
  epoch: 2,
}

function config(root: string) {
  return {
    ...DEFAULT_PROJECT_CONFIG,
    paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: root },
  }
}

function subject(id: string, overrides: Partial<Subject> = {}): Subject {
  return {
    id,
    age: 40,
    sex: 'F',
    cohort: 'CTRL',
    ais: null,
    tSinceSci: null,
    cells: [],
    qc: null,
    qcRevision: 0,
    notes: '',
    registered: true,
    analysisEligible: true,
    t1Availability: 'available',
    ...overrides,
  }
}

const app: { current: AppState | null } = { current: null }

function Bootstrap({
  project = PROJECT,
  children,
}: {
  project?: ProjectRef
  children: ReactNode
}): ReactNode {
  const state = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    app.current = state
  })
  useLayoutEffect(() => {
    if (!booted.current) {
      booted.current = true
      state.markProjectCreated({
        project,
        cfg: config(project.root),
        configSha256: '0'.repeat(64),
      })
    }
  }, [state, project])
  return children
}

function RouteProbe(): ReactNode {
  const { route } = useApp()
  return <output data-testid="route-probe">{route}</output>
}

function runtime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    runs: [],
    jobs: [],
    logs: [],
    logReplay: { entries: new Map(), snapshotJobs: new Map() },
    provision: null,
    summary: null,
    hydrating: false,
    error: null,
    authoritativeRuntimeKnown: true,
    authorityState: 'known',
    retryHydration: () => undefined,
    activeRuns: [],
    activeJobs: [],
    activeCount: 0,
    ...overrides,
  }
}

function tree(runtimeState: RuntimeState): ReactNode {
  return (
    <AppProvider>
      <RuntimeContext value={runtimeState}>
        <Bootstrap>
          <AnalysisScreen />
          <RouteProbe />
        </Bootstrap>
      </RuntimeContext>
    </AppProvider>
  )
}

function renderScreen(
  api = createMockApi(),
  runtimeState: RuntimeState = runtime(),
) {
  window.supraspina = api
  const view = render(tree(runtimeState))
  return {
    api,
    ...view,
    rerenderWith: (next: RuntimeState) => view.rerender(tree(next)),
  }
}

function summary(
  overrides: Partial<GroupAnalysisResultSummary> = {},
): GroupAnalysisResultSummary {
  const result = MOCK_ANALYSIS_RESULT
  return {
    resultId: result.resultId,
    schemaVersion: 1,
    specId: result.specId,
    name: result.name,
    analysis: result.spec.analysis,
    specDigest: result.specDigest,
    createdAt: result.createdAt,
    measureCount: result.rows.length,
    significantCount: 2,
    groups: result.sample.groups,
    provisional: false,
    pinned: false,
    currency: 'current',
    staleReasons: [],
    ...overrides,
  }
}

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const report = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
  })
  return report.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  app.current = null
})

describe('AnalysisScreen', () => {
  it('shows the stored result on the forest tab as current', async () => {
    renderScreen()
    expect(
      await screen.findByRole('img', { name: /Forest plot: SCI vs controls/ }),
    ).toBeInTheDocument()
    expect(screen.getByText('Current')).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: 'Forest', selected: true }),
    ).toBeInTheDocument()
    // The summary strip states the contrast, model, and inference.
    expect(
      await screen.findByText('SCI vs CTRL, n 34 / 48'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('max-T FWE, 5000 permutations, two-sided, alpha 0.05'),
    ).toBeInTheDocument()
    // Current inputs are the normal state and need no phrase.
    expect(screen.queryByText(/Inputs current/i)).toBeNull()
    // With one result, the header states its compute time as a medium date.
    const computed = new Date(MOCK_ANALYSIS_RESULT.createdAt).toLocaleString(
      undefined,
      { dateStyle: 'medium', timeStyle: 'short' },
    )
    expect(screen.getByText(`Computed ${computed}`)).toBeInTheDocument()
  })

  it('never reads current while the pipeline inputs are unjudged', async () => {
    // The header must not read "Current" while the summary strip reads "Inputs
    // not yet judged".
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
    })
    renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    expect(await screen.findByText('Not yet judged')).toBeInTheDocument()
    expect(screen.getByText('Draft inputs not yet judged')).toBeInTheDocument()
    expect(screen.queryByText('Current')).toBeNull()
  })

  it('reads provisional while a pipeline input is out of date', async () => {
    const api = createMockApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        aggregate: { state: 'outdated', outdatedSubjectIds: [] },
        pybrainage: { state: 'current', outdatedSubjectIds: [] },
      },
    })
    renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    expect(await screen.findByText('Provisional')).toBeInTheDocument()
    expect(screen.getByText('Draft inputs out of date')).toBeInTheDocument()
    expect(screen.queryByText('Current')).toBeNull()
  })

  it('computes with the stage currency, shows progress, then the result', async () => {
    const { api } = renderScreen()
    const start = vi.spyOn(api.groupAnalysis, 'start')
    await screen.findByRole('img', { name: /Forest plot/ })
    const compute = await screen.findByRole('button', { name: 'Compute' })
    await waitFor(() => expect(compute).toBeEnabled())
    fireEvent.click(compute)
    expect(await screen.findByText('Computing')).toBeInTheDocument()
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        project: PROJECT,
        spec: expect.objectContaining({ schemaVersion: 2 }),
        stageCurrency: {
          aggregate: 'current',
          pybrainage: 'current',
          recon: { state: 'unknown', outdatedSubjectIds: [] },
        },
      }),
    )
    expect(
      screen.getByRole('button', { name: 'Cancel the compute' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(/Permuting: /, {}, { timeout: 3000 }),
    ).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByText('Current')).toBeInTheDocument(),
      {
        timeout: 4000,
      },
    )
    expect(
      screen.queryByRole('button', { name: 'Cancel the compute' }),
    ).toBeNull()
    expect(
      await screen.findByRole('img', { name: /Forest plot/ }),
    ).toBeInTheDocument()
  })

  it('cancels a running compute and keeps the shown result', async () => {
    const { api } = renderScreen()
    const cancel = vi.spyOn(api.groupAnalysis, 'cancel')
    // Hold the compute running until the cancel lands: the mock finishes
    // after MOCK_COMPUTE_POLLS reads (about 2 s), and on a busy runner the
    // role queries before the click can take longer than that.
    const start = vi.spyOn(api.groupAnalysis, 'start')
    const status = api.groupAnalysis.status
    const statusSpy = vi
      .spyOn(api.groupAnalysis, 'status')
      .mockImplementation(async (request) => {
        const started = start.mock.results.at(-1)?.value as
          | ReturnType<typeof api.groupAnalysis.start>
          | undefined
        if (cancel.mock.calls.length > 0 || started === undefined) {
          return status(request)
        }
        return { operation: (await started).operation }
      })
    await screen.findByRole('img', { name: /Forest plot/ })
    const compute = screen.getByRole('button', { name: 'Compute' })
    await waitFor(() => expect(compute).toBeEnabled())
    // Await the start and the cancel themselves rather than polling role
    // and text queries for their effects: on a loaded worker each query of
    // this page costs hundreds of milliseconds, and polling them on every
    // DOM mutation ran past the 1 s findBy budget.
    fireEvent.click(compute)
    expect(start).toHaveBeenCalledOnce()
    await act(async () => {
      await start.mock.results[0]?.value
    })
    const reads = statusSpy.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the compute' }))
    expect(cancel).toHaveBeenCalledOnce()
    await act(async () => {
      await cancel.mock.results[0]?.value
    })
    // The cancel reads the status once it lands; settle that read too.
    expect(statusSpy.mock.calls.length).toBeGreaterThan(reads)
    await act(async () => {
      await statusSpy.mock.results.at(-1)?.value
    })
    expect(
      screen.getByText(
        'The compute was canceled; the shown result is unchanged.',
      ),
    ).toBeInTheDocument()
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: expect.stringMatching(/^gan-/) }),
    )
    expect(screen.getByRole('img', { name: /Forest plot/ })).toBeInTheDocument()
  })

  it('shows the result a compute committed before the cancel landed', async () => {
    // The worker has written its result when the cancel arrives, so the compute
    // finished; the panel must not say it was canceled.
    const { api } = renderScreen()
    const original = api.groupAnalysis.status
    const result = vi.spyOn(api.groupAnalysis, 'result')
    vi.spyOn(api.groupAnalysis, 'cancel').mockImplementation(
      async ({ operationId }) => {
        api.groupAnalysis.status = async (request) => {
          const { operation } = await original(request)
          return {
            operation: operation && {
              ...operation,
              operationId,
              state: 'done',
              phase: null,
              finishedAt: new Date().toISOString(),
              resultId: MOCK_ANALYSIS_RESULT.resultId,
            },
          }
        }
        return { operationId, stopped: false }
      },
    )
    await screen.findByRole('img', { name: /Forest plot/ })
    const compute = screen.getByRole('button', { name: 'Compute' })
    await waitFor(() => expect(compute).toBeEnabled())
    const reads = result.mock.calls.length
    fireEvent.click(compute)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Cancel the compute' }),
    )
    await waitFor(
      () => expect(result.mock.calls.length).toBeGreaterThan(reads),
      { timeout: 4000 },
    )
    expect(
      await screen.findByRole('img', { name: /Forest plot/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(
        'The compute was canceled; the shown result is unchanged.',
      ),
    ).toBeNull()
  })

  it('shows a v2 result in the v2 view, not an error', async () => {
    const api = createMockApi()
    const original = api.groupAnalysis.list
    api.groupAnalysis.list = async (request) => {
      const list = await original(request)
      return {
        ...list,
        results: [mockV2Summary(MOCK_BATTERY_RESULT), ...list.results],
      }
    }
    renderScreen(api)
    expect(await screen.findByLabelText('Term')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Grid' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
    // The Result select states each time, so no separate line repeats it.
    const computed = new Date(MOCK_BATTERY_RESULT.createdAt).toLocaleString(
      undefined,
      { dateStyle: 'medium', timeStyle: 'short' },
    )
    const option = screen.getByRole('option', {
      name: `${MOCK_BATTERY_RESULT.name}, ${computed}`,
    })
    expect(option.closest('select')).toHaveAttribute(
      'title',
      `${MOCK_BATTERY_RESULT.name}, ${computed}`,
    )
    expect(screen.queryByText(/^Computed /)).toBeNull()
    expect(
      await screen.findByRole('img', {
        name: /^Forest plot: Within SCI, clinical battery/,
      }),
    ).toBeInTheDocument()
    // Export opens the v2 dialog, which lists the term tables.
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    expect(
      await screen.findByText(/one row per term and measure/),
    ).toBeInTheDocument()
  })

  it('polls the status only while a compute runs', async () => {
    const { api } = renderScreen()
    const status = vi.spyOn(api.groupAnalysis, 'status')
    await screen.findByRole('img', { name: /Forest plot/ })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200))
    })
    expect(status).not.toHaveBeenCalled()
  })

  it('drops a late answer for the project it left', async () => {
    const api = createMockApi()
    let release: (list: GroupAnalysisList) => void = () => undefined
    const original = api.groupAnalysis.list
    api.groupAnalysis.list = async (request) => {
      if (request.project.projectId === PROJECT.projectId) {
        return new Promise<GroupAnalysisList>((resolve) => {
          release = resolve
        })
      }
      return original(request)
    }
    renderScreen(api)
    await waitFor(() =>
      expect(app.current?.projectRef?.projectId).toBe(PROJECT.projectId),
    )
    // The read starts in an effect, so wait for its text; under load it can
    // render after a synchronous query.
    expect(
      await screen.findByText('Reading the stored analyses'),
    ).toBeInTheDocument()
    act(() => {
      const epoch = app.current!.reserveCreateEpoch()
      app.current!.markProjectCreated({
        project: { ...OTHER, epoch },
        cfg: config(OTHER.root),
        configSha256: '1'.repeat(64),
      })
    })
    await screen.findByRole('img', { name: /Forest plot/ })
    const late = await original({ project: PROJECT })
    await act(async () => {
      release({
        ...late,
        results: [
          summary({
            currency: 'stale',
            staleReasons: [
              { code: 'engine-changed', added: 0, removed: 0, sources: [] },
            ],
          }),
        ],
      })
    })
    expect(screen.queryByText('This result is out of date.')).toBeNull()
    expect(screen.getByText('Current')).toBeInTheDocument()
  })

  it.each([
    ['an ended run', 'endedRunsKey'],
    ['a QC verdict change', 'qcKey'],
    ['a saved cohort selection change', 'cohortConfigKey'],
  ])('judges the result again after %s', async (_label, trigger) => {
    const api = createMockApi()
    api.subjects.discover = async () => [subject('sub-001'), subject('sub-002')]
    let stale = false
    const original = api.groupAnalysis.list
    api.groupAnalysis.list = async (request) => {
      const list = await original(request)
      return stale
        ? {
            ...list,
            results: [
              summary({
                currency: 'stale',
                staleReasons: [
                  {
                    code: 'qc-changed-sample',
                    added: 1,
                    removed: 2,
                    sources: [],
                  },
                ],
              }),
            ],
          }
        : list
    }
    const { rerenderWith } = renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    await waitFor(() => expect(app.current?.subjects.length).toBe(2))
    expect(screen.queryByText('This result is out of date.')).toBeNull()
    stale = true
    if (trigger === 'endedRunsKey') {
      const ended = {
        runId: 'run-1',
        endedAt: 1_700_000_000_000,
      } as unknown as RunSnapshot
      rerenderWith(runtime({ runs: [ended] }))
    } else if (trigger === 'qcKey') {
      act(() => {
        app.current!.applyQcWrite(app.current!.projectRef!, {
          subjectId: 'sub-001',
          verdict: 'fail',
          note: '',
          tags: [],
          revision: 3,
          updatedAt: '2026-09-30T12:00:00.000Z',
        })
      })
    } else {
      const cfg = app.current!.cfg
      await act(async () => {
        await app.current!.saveProject({
          ...cfg,
          subjects: { ...cfg.subjects, exclude: ['sub-002'] },
        })
      })
    }
    expect(
      await screen.findByText('This result is out of date.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'QC verdicts changed the included subjects since this result: 1 added, 2 removed. Compute again to update it.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Out of date')).toBeInTheDocument()
  })

  it('stamps a provisional result and says a run is live', async () => {
    const api = createMockApi()
    const original = api.groupAnalysis.list
    api.groupAnalysis.list = async (request) => ({
      ...(await original(request)),
      results: [summary({ provisional: true })],
    })
    const result = api.groupAnalysis.result
    api.groupAnalysis.result = async (request) => ({
      ...(await result(request)),
      provisional: true,
    })
    renderScreen(api, runtime({ activeCount: 1 }))
    await screen.findByRole('img', { name: /Forest plot/ })
    expect(screen.getAllByText('Provisional').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('A run is live.')).toBeInTheDocument()
  })

  it('disables measures whose table is missing, with a way to Runs', async () => {
    const api = createMockApi()
    api.groupAnalysis.catalog = async () => {
      const catalog = mockAnalysisCatalog()
      return {
        ...catalog,
        inputs: catalog.inputs.map((input) =>
          input.source === 'dk-all-stats'
            ? {
                ...input,
                present: false,
                reason:
                  'outputs/run/structural/dk_all_stats.csv is missing; run Aggregate.',
                sha256: null,
                bytes: null,
              }
            : input,
        ),
      }
    }
    renderScreen(api)
    expect(
      await screen.findByText(
        'outputs/run/structural/dk_all_stats.csv is missing; run Aggregate.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Open Runs' })[0]!)
    expect(screen.getByTestId('route-probe')).toHaveTextContent('runs')
  })

  it('holds Compute until the aggregation has output and clears the failure after', async () => {
    const api = createMockApi()
    let produced = false
    api.groupAnalysis.catalog = async () => {
      const catalog = mockAnalysisCatalog()
      return {
        ...catalog,
        inputs: catalog.inputs.map((input) =>
          input.source === 'dk-all-stats' && !produced
            ? { ...input, present: false, sha256: null, bytes: null }
            : input,
        ),
      }
    }
    const original = api.groupAnalysis.list
    api.groupAnalysis.list = async (request) => ({
      ...(await original(request)),
      results: [],
    })
    api.groupAnalysis.status = async () => ({
      operation: {
        operationId: 'gan-0123456789abcdef',
        state: 'failed',
        phase: null,
        completed: 0,
        total: 1,
        startedAt: '2026-09-30T10:00:00Z',
        finishedAt: '2026-09-30T10:00:01Z',
        message: 'No selected measure has enough values to fit.',
        specDigest: 'a'.repeat(64),
        resultId: null,
      },
    })
    const { rerenderWith } = renderScreen(api)
    const notice = await screen.findByText(
      'Structural aggregation has no output yet. Run all produces it.',
    )
    expect(notice).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compute' })).toBeDisabled()
    expect(
      screen.getByText('No selected measure has enough values to fit.'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getAllByText('SCI vs CTRL').length).toBeGreaterThan(0),
    )
    expect(screen.queryByText(/n \d+ \/ \d+/)).toBeNull()
    fireEvent.click(
      within(notice.closest('[role="status"]') as HTMLElement).getByRole(
        'button',
        { name: 'Open Runs' },
      ),
    )
    expect(screen.getByTestId('route-probe')).toHaveTextContent('runs')
    // A run writes the tables; the rejudge reads the catalog again.
    produced = true
    rerenderWith(
      runtime({
        runs: [{ runId: 'r1', endedAt: 1 } as unknown as RunSnapshot],
      }),
    )
    await waitFor(() =>
      expect(
        screen.queryByText(
          'Structural aggregation has no output yet. Run all produces it.',
        ),
      ).toBeNull(),
    )
    expect(
      screen.queryByText('No selected measure has enough values to fit.'),
    ).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Compute' })).toBeEnabled(),
    )
    expect(await screen.findByText(/n 34 \/ 48/)).toBeInTheDocument()
  })

  it('shows the empty state before any compute', async () => {
    const api = createMockApi()
    const original = api.groupAnalysis.list
    api.groupAnalysis.list = async (request) => ({
      ...(await original(request)),
      results: [],
    })
    renderScreen(api)
    expect(
      await screen.findByText(
        'No analysis has been computed for this project.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Not computed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export...' })).toBeDisabled()
  })

  it('moves between tabs with the arrow keys, Home, and End', async () => {
    renderScreen()
    const forest = await screen.findByRole('tab', { name: 'Forest' })
    forest.focus()
    fireEvent.keyDown(forest, { key: 'ArrowRight' })
    const measure = screen.getByRole('tab', { name: 'Measure' })
    expect(measure).toHaveAttribute('aria-selected', 'true')
    expect(measure).toHaveFocus()
    fireEvent.keyDown(measure, { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Brain' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Brain' }), {
      key: 'Home',
    })
    expect(screen.getByRole('tab', { name: 'Table' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Table' }), {
      key: 'ArrowLeft',
    })
    expect(screen.getByRole('tab', { name: 'Brain' })).toHaveFocus()
  })

  it("contains the rail's positioned descendants in its scroll area", async () => {
    // The visually hidden group legends are positioned absolutely; without a
    // positioned rail they would escape its clip and scroll the page.
    renderScreen()
    await screen.findByRole('img', { name: /Forest plot/ })
    const rail = screen.getByRole('complementary', {
      name: 'Analysis settings',
    })
    expect(rail.style.position).toBe('relative')
    expect(rail.style.overflowY).toBe('auto')
  })

  it('keeps the focus ring on the focusable result panel', async () => {
    // An inline `outline: none` on the tab panel would hide the global
    // :focus-visible ring.
    renderScreen()
    await screen.findByRole('img', { name: /Forest plot/ })
    const panel = screen.getByRole('tabpanel')
    expect(panel).toHaveAttribute('tabindex', '0')
    expect(panel.style.outline).toBe('')
    expect(panel.style.outlineStyle).toBe('')
  })

  it('moves the shared selection through table rows and opens the measure', async () => {
    renderScreen()
    fireEvent.click(await screen.findByRole('tab', { name: 'Table' }))
    const table = await screen.findByRole('table', { name: /Results of/ })
    const current = within(table)
      .getAllByRole('row')
      .find((row) => row.getAttribute('aria-current') === 'true')!
    // The first significant row is selected when a result opens.
    expect(current).toHaveTextContent('Precentral thickness')
    current.focus()
    fireEvent.keyDown(current, { key: 'ArrowDown' })
    const next = within(table)
      .getAllByRole('row')
      .find((row) => row.getAttribute('aria-current') === 'true')!
    expect(next).toHaveTextContent('Postcentral thickness')
    await waitFor(() => expect(next).toHaveFocus())
    fireEvent.keyDown(next, { key: 'End' })
    const last = within(table)
      .getAllByRole('row')
      .find((row) => row.getAttribute('aria-current') === 'true')!
    expect(last).toHaveTextContent('Mean cortical thickness')
    fireEvent.keyDown(last, { key: 'Enter' })
    expect(screen.getByRole('tab', { name: 'Measure' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      await screen.findByRole('img', {
        name: /Adjusted values: Mean cortical thickness/,
      }),
    ).toBeInTheDocument()
  })

  it('sorts the table and filters it to significant rows', async () => {
    renderScreen()
    fireEvent.click(await screen.findByRole('tab', { name: 'Table' }))
    const table = await screen.findByRole('table', { name: /Results of/ })
    fireEvent.click(within(table).getByRole('button', { name: /FWE p/ }))
    const header = within(table).getByRole('columnheader', { name: /FWE p/ })
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(screen.getByRole('switch', { name: 'Significant only' }))
    expect(within(table).getAllByRole('row')).toHaveLength(2)
  })

  it.each(['Table', 'Forest', 'Measure', 'Brain'])(
    'has no axe violations on the %s tab',
    async (name) => {
      const { container } = renderScreen()
      await screen.findByRole('img', { name: /Forest plot/ })
      fireEvent.click(screen.getByRole('tab', { name }))
      if (name === 'Measure') {
        await screen.findByRole('img', { name: /Adjusted values/ })
      }
      if (name === 'Brain') {
        await screen.findByText(NO_WEBGL2_MESSAGE)
      }
      expect(await axeViolations(container)).toEqual([])
    },
  )

  it('opens the controls as a side sheet in a narrow window', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(700)
    renderScreen()
    const edit = await screen.findByRole('button', { name: 'Edit analysis' })
    expect(
      screen.queryByRole('complementary', { name: 'Analysis settings' }),
    ).toBeNull()
    fireEvent.click(edit)
    const sheet = await screen.findByRole('dialog', {
      name: 'Analysis settings',
    })
    const title = within(sheet).getByRole('heading', {
      name: 'Analysis settings',
    })
    expect(title.style.fontSize).toBe('18px')
    expect(title.style.fontFamily).toContain('WebCM Serif 10')
    expect(
      within(sheet).getByRole('button', { name: /Choose measures/ }),
    ).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('updates the live included count when the QC rule changes', async () => {
    renderScreen()
    await screen.findByRole('img', { name: /Forest plot/ })
    fireEvent.click(screen.getByRole('button', { name: /Include subjects/ }))
    expect(await screen.findByText(/of 82 subjects/)).toHaveTextContent(
      '82 of 82',
    )
    fireEvent.change(screen.getByLabelText('QC verdict'), {
      target: { value: 'passed' },
    })
    await waitFor(() =>
      expect(screen.getByText(/of 82 subjects/)).toHaveTextContent('75 of 82'),
    )
    fireEvent.click(screen.getByRole('button', { name: '7 left out' }))
    expect(screen.getAllByText('No QC Pass')).toHaveLength(7)
    // The draft now differs from the shown result.
    expect(
      screen.getByText('The settings differ from this result.'),
    ).toBeInTheDocument()
  })

  it('exports figures and tables without participant IDs by default', async () => {
    const { api } = renderScreen()
    const choose = vi.spyOn(api.groupAnalysis, 'chooseExportFolder')
    const write = vi.spyOn(api.groupAnalysis, 'writeExport')
    await screen.findByRole('img', { name: /Forest plot/ })
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Export the analysis',
    })
    const ids = within(dialog).getByRole('checkbox', {
      name: 'Include subjects.csv, which contains participant IDs',
    })
    expect(ids).not.toBeChecked()
    const button = within(dialog).getByRole('button', {
      name: 'Choose folder and export',
    })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await within(dialog).findByText(/files written/)).toBeInTheDocument()
    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultName: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}-sci-vs-controls$/,
        ),
      }),
    )
    const request = write.mock.calls[0]![0]
    expect(request.subjectCsv).toBe(false)
    expect(request.figures.map((f) => [f.kind, f.stem])).toEqual([
      ['svg', 'forest'],
      ['svg', 'measure-dk-bi-precentral-thickavg'],
    ])
    for (const figure of request.figures) {
      expect(figure.kind === 'svg' && figure.pdf).toBe(true)
      expect(figure.kind === 'svg' && figure.svg).not.toMatch(/sub-\d{3}/)
    }
  })
  it('offers a retry when the measure values cannot be read for an export', async () => {
    const api = createMockApi()
    const original = api.groupAnalysis.measureDetail
    let fail = true
    const detail = vi
      .spyOn(api.groupAnalysis, 'measureDetail')
      .mockImplementation((async (request: V1DetailRequest) => {
        if (fail) throw new Error('The workflow service is not ready.')
        return original(request)
      }) as typeof original)
    renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Export the analysis',
    })
    expect(
      await within(dialog).findByText('The workflow service is not ready.'),
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByText('Reading the measure values...'),
    ).toBeNull()
    const button = within(dialog).getByRole('button', {
      name: 'Choose folder and export',
    })
    expect(button).toBeDisabled()
    fail = false
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(button).toBeEnabled())
    expect(detail).toHaveBeenCalledTimes(2)
  })
  it('retries the measure values on the Measure tab', async () => {
    const api = createMockApi()
    const original = api.groupAnalysis.measureDetail
    let fail = true
    vi.spyOn(api.groupAnalysis, 'measureDetail').mockImplementation((async (
      request: V1DetailRequest,
    ) => {
      if (fail) throw new Error('The measure values could not be read.')
      return original(request)
    }) as typeof original)
    renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    fireEvent.click(screen.getByRole('tab', { name: 'Measure' }))
    expect(
      await screen.findByText('The measure values could not be read.'),
    ).toBeInTheDocument()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(
      await screen.findByRole(
        'img',
        { name: /^Adjusted values: / },
        { timeout: 3000 },
      ),
    ).toBeInTheDocument()
  })
  it('says the compute stopped when the workflow service restarts', async () => {
    const { api } = renderScreen()
    await screen.findByRole('img', { name: /Forest plot/ })
    const compute = screen.getByRole('button', { name: 'Compute' })
    await waitFor(() => expect(compute).toBeEnabled())
    fireEvent.click(compute)
    expect(await screen.findByText('Computing')).toBeInTheDocument()
    // The restarted service knows no operation.
    vi.spyOn(api.groupAnalysis, 'status').mockResolvedValue({
      operation: null,
    })
    expect(
      await screen.findByText(
        'The analysis stopped because the workflow service restarted.',
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Compute again.')).toBeInTheDocument()
    expect(screen.queryByText('Computing')).toBeNull()
    const again = screen.getByRole('button', { name: 'Compute' })
    await waitFor(() => expect(again).toBeEnabled())
    vi.mocked(api.groupAnalysis.status).mockRestore()
    fireEvent.click(again)
    await waitFor(() =>
      expect(
        screen.queryByText(
          'The analysis stopped because the workflow service restarted.',
        ),
      ).toBeNull(),
    )
  })
  it('holds Compute while the design check blocks it and names why', async () => {
    const api = createMockApi()
    const original = api.groupAnalysis.inputs
    api.groupAnalysis.inputs = async (request) => {
      const inputs = await original(request)
      return {
        ...inputs,
        designCheck: {
          ...inputs.designCheck!,
          ok: false,
          issues: [
            {
              code: 'residual-df',
              severity: 'blocking',
              testId: 't1',
              message:
                'This test fits 5 parameters to 4 subjects, so no residual degree of freedom is left.',
            },
          ],
        },
      }
    }
    renderScreen(api)
    expect(
      await screen.findByText('The design check blocks Compute.'),
    ).toBeInTheDocument()
    expect(
      screen.getAllByText(
        'This test fits 5 parameters to 4 subjects, so no residual degree of freedom is left.',
      ).length,
    ).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Compute' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Compute' })).toHaveAttribute(
      'title',
      'The design check blocks Compute.',
    )
  })

  it('names the skipped measures of a compute where nothing fits', async () => {
    const api = createMockApi()
    const original = api.groupAnalysis.inputs
    api.groupAnalysis.inputs = async (request) => ({
      ...(await original(request)),
      skippedMeasures: [
        {
          measureId: 'aseg:Brain-Stem',
          reason: 'Fewer subjects than model parameters.',
        },
      ],
    })
    api.groupAnalysis.status = async () => ({
      operation: {
        operationId: 'gan-0123456789abcdef',
        state: 'failed',
        phase: null,
        completed: 0,
        total: 1,
        startedAt: '2026-09-30T10:00:00Z',
        finishedAt: '2026-09-30T10:00:01Z',
        message: 'No selected measure has enough values to fit.',
        specDigest: 'a'.repeat(64),
        resultId: null,
      },
    })
    renderScreen(api)
    expect(
      await screen.findByText('No selected measure has enough values to fit.'),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(
        'Skipped: Brainstem volume: Fewer subjects than model parameters. Compute again to retry.',
      ),
    ).toBeInTheDocument()
  })

  it('never shows a result without fitted measures as current', async () => {
    const api = createMockApi()
    api.groupAnalysis.result = async () => ({
      ...MOCK_ANALYSIS_RESULT,
      rows: [],
      skipped: [
        {
          measureId: 'aseg:Brain-Stem',
          reason: 'Fewer subjects than model parameters.',
        },
      ],
    })
    renderScreen(api)
    expect(
      await screen.findByText('No measure could be fit in this result.'),
    ).toBeInTheDocument()
    expect(screen.getByText('No measure fit')).toBeInTheDocument()
    expect(screen.queryByText('Current')).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Table' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Export...' })).toBeDisabled()
  })
  it('exports a long forest as numbered pages within the figure limit', async () => {
    const api = createMockApi()
    const known = new Set(MOCK_ANALYSIS_RESULT.rows.map((r) => r.measureId))
    const template = MOCK_ANALYSIS_RESULT.rows.find((r) => !r.significant)!
    const extra = mockAnalysisCatalog()
      .measures.filter((m) => !known.has(m.measureId))
      .slice(0, 646 - known.size)
      .map((m) => ({ ...template, measureId: m.measureId, family: m.family }))
    api.groupAnalysis.result = async () => ({
      ...MOCK_ANALYSIS_RESULT,
      rows: [...MOCK_ANALYSIS_RESULT.rows, ...extra],
    })
    const write = vi.spyOn(api.groupAnalysis, 'writeExport')
    renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Export the analysis',
    })
    expect(
      within(dialog).getByText('11 pages of up to 60 rows, one file each.'),
    ).toBeInTheDocument()
    const button = within(dialog).getByRole('button', {
      name: 'Choose folder and export',
    })
    // With PNG too, the pages need more figures than one export holds.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'PNG' }))
    expect(
      within(dialog).getByText(
        'This export needs 24 figure files; one export holds at most 16.',
      ),
    ).toBeInTheDocument()
    expect(button).toBeDisabled()
    fireEvent.click(
      within(dialog).getByRole('radio', { name: 'Significant and largest' }),
    )
    expect(within(dialog).queryByText(/one export holds at most/)).toBeNull()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'PNG' }))
    fireEvent.click(
      within(dialog).getByRole('radio', { name: 'All 646 measures' }),
    )
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(await within(dialog).findByText(/files written/)).toBeInTheDocument()
    const stems = write.mock.calls[0]![0].figures.map((f) => f.stem)
    expect(stems.slice(0, 11)).toEqual(
      Array.from(
        { length: 11 },
        (_, i) => `forest-p${String(i + 1).padStart(2, '0')}`,
      ),
    )
    expect(within(dialog).queryByText(/between 1 and 1000 mm/)).toBeNull()
  })
  it('exports under an edited folder name and reports a suffixed one', async () => {
    const { api } = renderScreen()
    const write = vi.spyOn(api.groupAnalysis, 'writeExport')
    await screen.findByRole('img', { name: /Forest plot/ })
    const exportOnce = async (): Promise<HTMLElement> => {
      fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
      const dialog = await screen.findByRole('dialog', {
        name: 'Export the analysis',
      })
      const name = within(dialog).getByRole('textbox', { name: 'Folder name' })
      expect((name as HTMLInputElement).value).toMatch(
        /^\d{4}-\d{2}-\d{2}-sci-vs-controls$/,
      )
      const button = within(dialog).getByRole('button', {
        name: 'Choose folder and export',
      })
      fireEvent.change(name, { target: { value: 'Figure 2' } })
      expect(
        within(dialog).getByText(/^Name the folder with 1 to 128 lowercase/),
      ).toBeInTheDocument()
      expect(button).toBeDisabled()
      fireEvent.change(name, { target: { value: 'figure-2' } })
      await waitFor(() => expect(button).toBeEnabled())
      fireEvent.click(button)
      await within(dialog).findByText(/files written/)
      return dialog
    }
    const first = await exportOnce()
    expect(within(first).queryByText(/already existed/)).toBeNull()
    fireEvent.click(within(first).getByRole('button', { name: 'Done' }))
    const second = await exportOnce()
    expect(
      within(second).getByText(
        'A folder named figure-2 already existed, so the export went to figure-2-2.',
      ),
    ).toBeInTheDocument()
    expect(write.mock.calls.map((call) => call[0].folderName)).toEqual([
      'figure-2',
      'figure-2',
    ])
  })
  it('includes the drawn brain view as a PNG only while one is drawn', async () => {
    renderScreen()
    await screen.findByRole('img', { name: /Forest plot/ })
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Export the analysis',
    })
    expect(
      within(dialog).getByRole('checkbox', { name: 'Brain view image (PNG)' }),
    ).toBeDisabled()
    expect(
      within(dialog).getByText(
        'Open the Brain tab and let it draw to include its current view.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('writes the brain PNG the Brain tab offers', async () => {
    const api = createMockApi()
    window.supraspina = api
    const write = vi.spyOn(api.groupAnalysis, 'writeExport')
    const capture = vi.fn(async () => Uint8Array.from([137, 80, 78, 71]))
    render(
      <AppProvider>
        <Bootstrap>
          <ExportDialog
            project={PROJECT}
            result={MOCK_ANALYSIS_RESULT}
            measureId={null}
            detail={null}
            requestDetail={() => undefined}
            brain={{ stem: 'brain-d-thickavg-bi-lh-lateral-inflated', capture }}
            onClose={() => undefined}
          />
        </Bootstrap>
      </AppProvider>,
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Export the analysis',
    })
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'Brain view image: brain-d-thickavg-bi-lh-lateral-inflated.png',
      }),
    )
    // The brain figure is a PNG, so its resolution is offered with it.
    fireEvent.click(within(dialog).getByRole('radio', { name: '600 dpi' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: '85 mm' }))
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Choose folder and export' }),
    )
    await within(dialog).findByText(/files written/)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith({ widthMm: 85, dpi: 600 })
    expect(
      write.mock.calls[0]![0].figures.map((f) => [f.kind, f.stem]).at(-1),
    ).toEqual(['png', 'brain-d-thickavg-bi-lh-lateral-inflated'])
  })

  it('refuses an export too large for one request before writing', async () => {
    const api = createMockApi()
    window.supraspina = api
    const write = vi.spyOn(api.groupAnalysis, 'writeExport')
    const capture = vi.fn(async () => new Uint8Array(33 * 1024 * 1024))
    render(
      <AppProvider>
        <Bootstrap>
          <ExportDialog
            project={PROJECT}
            result={MOCK_ANALYSIS_RESULT}
            measureId={null}
            detail={null}
            requestDetail={() => undefined}
            brain={{ stem: 'brain-d-slices-fsaverage', capture }}
            onClose={() => undefined}
          />
        </Bootstrap>
      </AppProvider>,
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Export the analysis',
    })
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'Brain view image: brain-d-slices-fsaverage.png',
      }),
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Choose folder and export' }),
    )
    expect(
      await within(dialog).findByText(/Export fewer figures or formats/),
    ).toBeInTheDocument()
    expect(write).not.toHaveBeenCalled()
  })

  it('shows the sample issues of the draft and of the result as facts', async () => {
    const api = createMockApi()
    const inputs = api.groupAnalysis.inputs
    api.groupAnalysis.inputs = async (request) => ({
      ...(await inputs(request)),
      issues: ['outliers.csv is missing, so the outlier rule cannot apply.'],
    })
    api.groupAnalysis.result = async () => ({
      ...MOCK_ANALYSIS_RESULT,
      sample: {
        ...MOCK_ANALYSIS_RESULT.sample,
        issues: ['The outlier rule could not apply to this sample.'],
      },
    })
    renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    expect(
      await screen.findByText(
        'outliers.csv is missing, so the outlier rule cannot apply.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('The outlier rule could not apply to this sample.'),
    ).toBeInTheDocument()
  })

  it('states a site warning a spec v1 result carries', async () => {
    const warning =
      'Site B holds only CTRL subjects; with site as a covariate they inform the other covariates and the residual variance, not the group difference.'
    const api = createMockApi()
    api.groupAnalysis.result = async () => ({
      ...MOCK_ANALYSIS_RESULT,
      sample: { ...MOCK_ANALYSIS_RESULT.sample, issues: [warning] },
    })
    renderScreen(api)
    await screen.findByRole('img', { name: /Forest plot/ })
    expect(await screen.findByText(warning)).toBeInTheDocument()
  })

  it("names the failed compute's own skipped measures", async () => {
    const api = createMockApi()
    api.groupAnalysis.status = async () => ({
      operation: {
        operationId: 'gan-0123456789abcdef',
        state: 'failed',
        phase: null,
        completed: 0,
        total: 1,
        startedAt: '2026-09-30T10:00:00Z',
        finishedAt: '2026-09-30T10:00:01Z',
        message: 'No selected measure has enough values to fit.',
        specDigest: 'a'.repeat(64),
        resultId: null,
        skipped: [
          {
            measureId: 'global:eTIV',
            reason: 'Fewer subjects than model parameters.',
          },
        ],
      },
    })
    renderScreen(api)
    expect(
      await screen.findByText(
        'Skipped: Estimated total intracranial volume: Fewer subjects than model parameters. Compute again to retry.',
      ),
    ).toBeInTheDocument()
  })

  it('keeps each export dialog row at its content height and scrolls the card', async () => {
    renderScreen()
    await screen.findByRole('img', { name: /Forest plot/ })
    fireEvent.click(screen.getByRole('button', { name: 'Export...' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Export the analysis',
    })
    // A grid sizes each row to its content; a flex column shrinks rows that
    // clip their content when the window is short.
    expect(dialog.style.display).toBe('grid')
    expect(dialog.style.alignContent).toBe('start')
    expect(dialog.style.overflow).toBe('auto')
  })
})
