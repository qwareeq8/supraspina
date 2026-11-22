import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'
import App, {
  ATTENTION_CHIP_ALLOWANCE,
  CAPTION_CONTROLS_WIDTH,
  FULL_BAR_BUDGET,
  PALETTE_BUTTON_MIN_WIDTH,
  PALETTE_SUBJECT_LIMIT,
} from './App'
import { createMockApi, makeMockCohort } from './ipc/mock'
import { emptyAnalysisCohortReason } from '../shared/analysis-cohort'
import { DEFAULT_PROJECT_CONFIG } from '../shared/project-schema'
import type { ProjectConfig } from '../shared/project-schema'
import { PLAN_STALE_MESSAGE } from '../shared/rpc-errors'
import { MATRIX_STEPS } from '../shared/steps'
import type {
  HostState,
  ProjectOpenResult,
  ResultPage,
  RunSnapshot,
  RuntimeSnapshot,
  SupraspinaApi,
  WorkflowResult,
} from '../shared/contract'
import type {
  EnvReport,
  Job,
  RunManifest,
  Subject,
  ToolStatus,
  ToolStatusItem,
} from '../shared/types'

/** A loaded project configuration with a concrete root. */
const LOADED_PROJECT: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
  project: { ...DEFAULT_PROJECT_CONFIG.project, name: 'Loaded study' },
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: '/data/projects/demo',
  },
}

const LOADED_PROJECT_RESULT: ProjectOpenResult = {
  project: {
    projectId: 'loaded-study',
    root: '/data/projects/demo',
    configPath: '/data/projects/demo/supraspina.project.json',
    epoch: 1,
  },
  cfg: LOADED_PROJECT,
  configSha256: '0'.repeat(64),
}

/**
 * Install a mock IPC bridge that returns a rooted project and selects its saved
 * configuration through the toolbar's "Open..." flow.
 */
function installLoadableBridge(
  api: SupraspinaApi = createMockApi(),
  cfg: ProjectConfig = LOADED_PROJECT,
): SupraspinaApi {
  const attachProject = api.project.open
  api.project.open = async ({ path, epoch }) => {
    const host = await api.host.getState()
    if (!host.sidecar.projectAttached) {
      await attachProject({ path, epoch })
    }
    return {
      ...LOADED_PROJECT_RESULT,
      cfg,
      project: { ...LOADED_PROJECT_RESULT.project, epoch },
    }
  }
  api.fs.chooseFile = async () => '/data/projects/demo/supraspina.project.json'
  ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
  return api
}

/**
 * Render the shell, and open a project through Open -> Open project file... to reveal the
 * gated navigation.
 */
async function renderWithProject(
  api?: SupraspinaApi,
  cfg?: ProjectConfig,
): Promise<SupraspinaApi> {
  const installed = installLoadableBridge(api, cfg)
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Open a saved project' }))
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Open project file...' }),
  )
  await waitFor(() =>
    expect(
      screen.getByLabelText('Current project: Loaded study'),
    ).toBeInTheDocument(),
  )
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  })
  return installed
}

function cohortApi(subjects: readonly Subject[]): SupraspinaApi {
  return createMockApi(subjects)
}

/** Resolve the browser host mock and project it into a packaged host state. */
async function packagedHost(
  api: SupraspinaApi,
  overrides: Omit<Partial<HostState>, 'sidecar'> & {
    sidecar?: Partial<HostState['sidecar']>
  } = {},
): Promise<HostState> {
  const base = await api.host.getState()
  return {
    ...base,
    ...overrides,
    sidecar: { ...base.sidecar, ...overrides.sidecar },
  }
}

/** Build a settled workflow result that schedules no work. */
function noopResult(message: string): WorkflowResult {
  const summary = {
    planned: 0,
    started: 0,
    waiting: 0,
    blocked: 0,
    skipped: 0,
    message,
  }
  return {
    runId: null,
    disposition: 'noop',
    plan: {
      planId: 'run-0123456789ab',
      analysisCohort: { subjectIds: [], sha256: 'a'.repeat(64) },
      selectedSubset: { subjectIds: [], sha256: 'a'.repeat(64) },
      nodes: [],
      blockers: [],
      summary,
      digest: 'b'.repeat(64),
    },
    summary,
  } as WorkflowResult
}

/** Launch Run all from the dock and accept the cohort confirmation. */
async function launchRunAllFromDock(name: string): Promise<void> {
  const runAll = await screen.findByRole('button', { name })
  await waitFor(() => expect(runAll).toBeEnabled())
  fireEvent.click(runAll)
  fireEvent.click(
    within(
      screen.getByRole('dialog', { name: 'Review the run plan?' }),
    ).getByRole('button', { name: 'Review plan' }),
  )
}

/** Switch tabs through the primary navigation rail. */
function openTab(label: string): void {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Primary' })).getByRole(
      'button',
      { name: label },
    ),
  )
}

/**
 * Build the entry a browser's ResizeObserver delivers for the top bar at a
 * border-box width. The content rect excludes the padding of the layout the
 * bar draws at that moment, so it differs between the two layouts.
 */
function topBarResizeEntry(width: number): ResizeObserverEntry {
  const bar = document.querySelector<HTMLElement>('header')
  const padding = bar
    ? (Number.parseFloat(bar.style.paddingLeft) || 0) +
      (Number.parseFloat(bar.style.paddingRight) || 0)
    : 0
  return {
    borderBoxSize: [{ inlineSize: width, blockSize: 40 }],
    contentRect: { width: width - padding },
  } as unknown as ResizeObserverEntry
}

/**
 * Give the navigation row and its hidden probe a layout, which jsdom lacks.
 * Each tab measures 100 wide with its bold label reserved, the More trigger
 * 104, and the gap 2, so thirteen tabs need 1324 and `count` tabs with More
 * need 104 + 102 * count.
 */
function mockRailLayout(initialWidth: number): {
  setWidth: (width: number) => void
  restore: () => void
} {
  let railWidth = initialWidth
  const probeWidths: Readonly<Record<string, number>> = {
    strong: 64,
    more: 30,
    tab: 36,
    trigger: 40,
  }
  const spy = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      const probe = this.getAttribute('data-nav-probe')
      const width = probe
        ? (probeWidths[probe] ?? 0)
        : this.matches('nav[aria-label="Primary"]')
          ? railWidth
          : 0
      return {
        width,
        height: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: 0,
      } as DOMRect
    })
  return {
    setWidth: (width) => {
      railWidth = width
    },
    restore: () => spy.mockRestore(),
  }
}

beforeEach(() => {
  // Complete first-run setup before testing the shell chrome.
  localStorage.setItem('supraspinaFirstRunDone', '1')
})

afterEach(() => {
  delete (globalThis as { supraspina?: SupraspinaApi }).supraspina
  delete (globalThis as { ResizeObserver?: typeof ResizeObserver })
    .ResizeObserver
  localStorage.clear()
})

describe('App', () => {
  it('shows the Supraspina brand and project toolbar in the top bar', () => {
    render(<App />)

    const topBar = screen.getByRole('banner')
    const brand = topBar.querySelector('img')
    expect(brand).toHaveAttribute('alt', '')
    expect(brand?.getAttribute('src')).toMatch(/supraspina_icon\.svg$/)
    expect(within(topBar).getByText('Untitled project')).toBeInTheDocument()
    const newButton = screen.getByRole('button', { name: 'New' })
    const open = screen.getByRole('button', { name: 'Open a saved project' })
    // New and Open share one outline, height, and font, so they read as one
    // group.
    expect(open.style.border).toBe(newButton.style.border)
    expect(open.style.height).toBe(newButton.style.height)
    expect(open.style.fontSize).toBe(newButton.style.fontSize)
    expect(within(topBar).queryByText('mock')).not.toBeInTheDocument()
    expect(within(topBar).queryByText('electron')).not.toBeInTheDocument()
  })

  it('draws no workflow status while the service is ready and verified', async () => {
    await renderWithProject()

    const topBar = screen.getByRole('banner')
    // The mock host finds four of six tools, its scientific assets included.
    expect(
      await within(topBar).findByRole('button', {
        name: 'Open Diagnostics to fix 2 pipeline tools, 4 of 6 found',
      }),
    ).toBeInTheDocument()
    expect(
      within(topBar).queryByRole('button', { name: /^Review workflow/ }),
    ).toBeNull()
    expect(within(topBar).queryByText(/^Workflow /)).toBeNull()
  })

  it('separates workflow service state from the aligned tool chips', async () => {
    const api = createMockApi()
    const host = await packagedHost(api, {
      sidecar: { state: 'degraded', projectAttached: true },
    })
    api.host.getState = async () => host
    await renderWithProject(api)

    const topBar = screen.getByRole('banner')
    const workflow = await within(topBar).findByRole('button', {
      name: 'Review workflow degraded status in Diagnostics',
    })
    // The mock host finds four of six tools, its scientific assets included.
    const tools = within(topBar).getByRole('button', {
      name: 'Open Diagnostics to fix 2 pipeline tools, 4 of 6 found',
    })

    expect(workflow).toHaveTextContent('Workflow degraded')
    expect(workflow).toHaveStyle({
      alignItems: 'center',
      background: 'transparent',
      fontWeight: 400,
      height: '28px',
    })
    expect(workflow.style.borderRight).not.toBe('')
    expect(tools).toHaveStyle({ alignItems: 'center', height: '28px' })

    fireEvent.click(workflow)
    expect(
      screen.getByRole('heading', { name: 'Diagnostics' }),
    ).toBeInTheDocument()
  })

  it('compacts the top chrome when accessibility zoom reduces its layout width', async () => {
    const callbacks: ResizeObserverCallback[] = []
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    await renderWithProject()

    act(() => {
      const entry = topBarResizeEntry(900)
      for (const callback of callbacks) {
        callback([entry], {} as ResizeObserver)
      }
    })

    const topBar = screen.getByRole('banner')
    expect(topBar).toHaveAttribute('data-layout', 'compact')
    // The project name stays visible in the compact bar, truncated to a
    // bounded width, so the operator always knows which project is open.
    expect(
      within(topBar).getByLabelText('Current project: Loaded study'),
    ).toHaveStyle({ maxWidth: '160px' })
    expect(
      within(topBar).queryByText('Search or run...'),
    ).not.toBeInTheDocument()
    expect(
      within(topBar).getByRole('button', { name: 'Open command palette' }),
    ).toHaveStyle({ width: '34px' })
  })

  it('lets the full top chrome give back palette width instead of overflowing', async () => {
    // The full layout must reflow rather than push the page into a horizontal
    // scroll when a large text scale shrinks the effective viewport, so the
    // palette button states a preferred width it can yield down to a floor.
    await renderWithProject()

    const topBar = screen.getByRole('banner')
    expect(topBar).toHaveAttribute('data-layout', 'full')
    expect(PALETTE_BUTTON_MIN_WIDTH).toBeLessThan(240)
    expect(
      within(topBar).getByRole('button', { name: 'Open command palette' }),
    ).toHaveStyle({
      width: '240px',
      minWidth: `${PALETTE_BUTTON_MIN_WIDTH}px`,
      flexShrink: '1',
    })
  })

  // Mirror MINIMUM_WIDTH from src/main/window-placement.ts. The renderer cannot
  // import main-process modules, so window-placement.test.ts pins the same
  // relationship from the owning side.
  const MINIMUM_WINDOW_WIDTH = 1_100

  it('compacts the top chrome at the minimum window width when caption controls are drawn', async () => {
    // The caption controls never shrink, so the full layout must yield to the
    // compact layout at MINIMUM_WIDTH or the bar overflows and pushes the
    // close button off screen.
    const callbacks: ResizeObserverCallback[] = []
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    const api = cohortApi(makeMockCohort(4, 902))
    const host = await packagedHost(api, {
      mode: 'electron',
      platform: 'linux',
      captionMode: 'custom',
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    await renderWithProject(api)

    const resize = (width: number): void => {
      act(() => {
        for (const callback of callbacks) {
          callback([topBarResizeEntry(width)], {} as ResizeObserver)
        }
      })
    }
    resize(MINIMUM_WINDOW_WIDTH)

    expect(MINIMUM_WINDOW_WIDTH - CAPTION_CONTROLS_WIDTH).toBeLessThan(
      FULL_BAR_BUDGET,
    )
    expect(screen.getByRole('banner')).toHaveAttribute('data-layout', 'compact')
    // The controls take the place of the right padding: the full layout
    // returns once 1,040 px of content fit beside them and the left padding.
    resize(1_040 + 14 + CAPTION_CONTROLS_WIDTH - 1)
    expect(screen.getByRole('banner')).toHaveAttribute('data-layout', 'compact')
    resize(1_040 + 14 + CAPTION_CONTROLS_WIDTH)
    expect(screen.getByRole('banner')).toHaveAttribute('data-layout', 'full')
  })

  it('holds the Done count in the top bar and on the Dashboard until the stage currency read lands', async () => {
    const subjects = makeMockCohort(3, 904).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
      cells: subject.cells.map((cell) => ({ ...cell, st: 'done' as const })),
      stepStates: { recon: 'done' as const, final: 'done' as const },
    }))
    const api = cohortApi(subjects)
    let land: (page: ResultPage) => void = () => undefined
    const read = new Promise<ResultPage>((resolve) => {
      land = resolve
    })
    vi.spyOn(api.results, 'list').mockReturnValue(read)

    await renderWithProject(api)

    // Before the read, every finished subject may still be out of date: the
    // bar names no Done count rather than one it would withdraw.
    const checking = await screen.findByRole('img', {
      name: 'Cohort progress, checking stage currency: 3 done or out of date, 0 partly done, 0 running, 0 failed, and 0 pending of 3 subjects',
    })
    expect(checking).toHaveTextContent('-- of 3 done')
    expect(checking.getAttribute('title')).toMatch(/^3 subjects\. /)
    expect(
      screen.getByRole('button', {
        name: /^Open done subjects \(Done: checking stage currency\)\./,
      }),
    ).toHaveTextContent('--')
    expect(
      screen.getByText(
        'Subjects 3, Done checking, Out of date checking, Partly done 0, Running 0, Failed 0, Pending 0',
      ),
    ).toBeInTheDocument()

    await act(async () =>
      land({
        items: [],
        nextCursor: null,
        truncated: false,
        stageCurrency: {
          final: {
            state: 'outdated',
            outdatedSubjectIds: [],
            cause: 'analysis-cohort',
          },
        },
        analysisCohortChange: { cause: 'membership' },
      }),
    )
    const counted = await screen.findByRole('img', {
      name: 'Cohort progress: 0 done, 3 out of date, 0 partly done, 0 running, 0 failed, and 0 pending of 3 subjects',
    })
    expect(counted).toHaveTextContent('0 of 3 done')
    // The tooltip says the total is the analysis cohort.
    expect(counted.getAttribute('title')).toMatch(/^0 of 3 subjects done\. /)
    expect(
      screen.getByRole('button', {
        name: /^Open done subjects \(Done: 0\)\./,
      }),
    ).toBeInTheDocument()
  })

  it('counts a subject Done in the top bar once every enabled stage finished', async () => {
    // With PyBrainAge and the stages after it off, a Run all that finished
    // every enabled stage leaves no subject in progress.
    const cfg = structuredClone(LOADED_PROJECT)
    for (const key of [
      'pybrainage',
      'clinical',
      'brainpad',
      'final',
    ] as const) {
      cfg.steps[key] = { ...cfg.steps[key], enabled: false }
    }
    const subjects = makeMockCohort(2, 904).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
      cells: subject.cells.map((cell, index) => ({
        ...cell,
        st: ['pba', 'norm', 'stats', 'rep'].includes(
          MATRIX_STEPS[index]?.key ?? '',
        )
          ? ('pending' as const)
          : ('done' as const),
      })),
      stepStates: {},
    }))

    const resize = stubTopBarResize()
    await renderWithProject(cohortApi(subjects), cfg)

    const progress = await screen.findByRole('img', {
      name: 'Cohort progress: 2 done, 0 out of date, 0 partly done, 0 running, 0 failed, and 0 pending of 2 subjects',
    })
    expect(progress).toHaveTextContent('2 of 2 done')
    // The compact bar keeps the count in its short form.
    resize(FULL_BAR_BUDGET - 1)
    expect(screen.getByRole('banner')).toHaveAttribute('data-layout', 'compact')
    expect(
      within(screen.getByRole('banner')).getByRole('img', {
        name: /^Cohort progress: 2 done/,
      }),
    ).toHaveTextContent('2/2 done')
  })

  it('counts QC-fail subjects in the top bar and names the cut on the dock scope', async () => {
    const subjects = makeMockCohort(3, 905).map((subject, index) => ({
      ...subject,
      qc: index === 0 ? ('fail' as const) : ('pass' as const),
      analysisEligible: index !== 0,
      unavailableReason: null,
      cells: subject.cells.map((cell) => ({ ...cell, st: 'pending' as const })),
      stepStates: {},
    }))

    await renderWithProject(cohortApi(subjects))

    // The bar counts every discovered subject, as the Dashboard tiles do.
    const progress = await screen.findByRole('img', {
      name: /^Cohort progress.* of 3 subjects$/,
    })
    expect(progress).toHaveTextContent('of 3 done')
    expect(progress.getAttribute('aria-label')).toContain('1 excluded')
    // The dock keeps the analysis cohort and says why it is smaller.
    expect(
      await screen.findByTitle(
        '2 of 3 subjects are in the analysis cohort; 1 failed QC.',
      ),
    ).toHaveTextContent('All 2 subjects')
  })

  it('states the failed-subject count on the Subjects tab', async () => {
    const subjects = makeMockCohort(3, 906).map((subject, index) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
      cells: subject.cells.map((cell, cellIndex) => ({
        ...cell,
        st:
          index < 2 && cellIndex === 0
            ? ('failed' as const)
            : ('pending' as const),
      })),
      stepStates: {},
    }))

    await renderWithProject(cohortApi(subjects))

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    await waitFor(() =>
      expect(
        within(rail).getByRole('button', { name: 'Subjects' }),
      ).toHaveAccessibleDescription('2 subjects have a failed step.'),
    )
  })

  it('keeps the top-bar cohort progress in step with the Dashboard tiles when cohort stages are out of date', async () => {
    const cohortStages = [
      'enigma',
      'outliers',
      'features',
      'age',
      'pybrainage',
      'clinical',
      'brainpad',
      'aggregate',
      'final',
    ] as const
    const subjects = makeMockCohort(3, 903).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
      cells: subject.cells.map((cell) => ({ ...cell, st: 'done' as const })),
      stepStates: Object.fromEntries(
        ['recon', ...cohortStages].map((key) => [key, 'done' as const]),
      ),
    }))
    const api = cohortApi(subjects)
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: Object.fromEntries(
        cohortStages.map((key) => [
          key,
          {
            state: 'outdated' as const,
            outdatedSubjectIds: [],
            cause: 'analysis-cohort' as const,
          },
        ]),
      ),
      analysisCohortChange: { cause: 'membership' },
    })

    await renderWithProject(api)

    expect(
      await screen.findByRole('img', {
        name: 'Cohort progress: 0 done, 3 out of date, 0 partly done, 0 running, 0 failed, and 0 pending of 3 subjects',
      }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(
        'Subjects 3, Done 0, Out of date 3, Partly done 0, Running 0, Failed 0, Pending 0',
      ),
    ).toBeInTheDocument()

    // The tile opens the Subjects filter of the same name and count.
    fireEvent.click(
      screen.getByRole('button', {
        name: /^Open out-of-date subjects \(Out of date: 3\)\./,
      }),
    )
    expect(
      await screen.findByRole('radio', { name: 'Out of date 3' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      screen.getByText(
        '0 done, 3 out of date, 0 partly done, 0 running, 0 failed, and 0 pending subjects.',
      ),
    ).toBeInTheDocument()
  })

  it('renders packaged window controls, tool severities, and every cohort roll-up state', async () => {
    const states = [
      'done',
      'running',
      'failed',
      'interrupted',
      'cancelled',
      'pending',
    ] as const
    const subjects = makeMockCohort(6, 901).map((subject, index) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
      cells: subject.cells.map((cell, cellIndex) => ({
        ...cell,
        st:
          states[index] === 'done'
            ? ('done' as const)
            : cellIndex === 0
              ? states[index]!
              : ('pending' as const),
      })),
    }))
    const api = cohortApi(subjects)
    const host = await packagedHost(api, {
      mode: 'electron',
      platform: 'linux',
      captionMode: 'custom',
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const toolStatus: ToolStatus = {
      capturedAt: '2026-07-22T00:00:00.000Z',
      summary: 'missing',
      items: [
        { id: 'ok', label: 'FreeSurfer', status: 'ok' },
        { id: 'warn', label: 'QC backend', status: 'warn' },
        { id: 'missing', label: 'R packages', status: 'missing' },
        { id: 'na', label: 'PyBrainAge', status: 'na' },
      ],
    }
    api.env.toolStatus = async () => toolStatus
    const minimize = vi.spyOn(api.window, 'minimize')
    const toggleMaximize = vi.spyOn(api.window, 'toggleMaximize')
    const close = vi.spyOn(api.window, 'close')

    await renderWithProject(api)

    expect(
      await screen.findByRole('img', {
        // Interrupted and canceled work did not fail and counts apart.
        name: 'Cohort progress: 1 done, 0 out of date, 0 partly done, 1 running, 1 failed, 1 interrupted, 1 canceled, and 1 pending of 6 subjects',
      }),
    ).toBeInTheDocument()
    // The not-applicable tool stays out of the count.
    const tools = screen.getByRole('button', {
      name: 'Open Diagnostics to fix 2 pipeline tools, 1 of 3 found',
    })
    // Only the tools that need attention count, in one chip that states the
    // problem in words: a found tool and one the saved configuration does not
    // use stay out of it.
    expect(
      within(tools)
        .getAllByText(/./)
        .map((node) => node.textContent),
    ).toEqual(['2 tools need setup'])
    expect(within(tools).getByText('2 tools need setup')).toHaveAttribute(
      'title',
      expect.stringMatching(/^QC backend: .* R packages: /),
    )
    expect(within(tools).queryByText('FreeSurfer')).toBeNull()
    expect(within(tools).queryByText('PyBrainAge')).toBeNull()

    const minimizeButton = screen.getByRole('button', { name: 'Minimize' })
    fireEvent.mouseEnter(minimizeButton)
    fireEvent.mouseLeave(minimizeButton)
    fireEvent.click(minimizeButton)
    expect(minimize).toHaveBeenCalledOnce()

    const maximizeButton = screen.getByRole('button', { name: 'Maximize' })
    fireEvent.mouseEnter(maximizeButton)
    fireEvent.mouseLeave(maximizeButton)
    fireEvent.click(maximizeButton)
    expect(toggleMaximize).toHaveBeenCalledOnce()
    const restoreButton = await screen.findByRole('button', { name: 'Restore' })
    fireEvent.click(restoreButton)
    await screen.findByRole('button', { name: 'Maximize' })

    const closeButton = screen.getByRole('button', { name: 'Close' })
    fireEvent.mouseEnter(closeButton)
    fireEvent.mouseLeave(closeButton)
    fireEvent.click(closeButton)
    expect(close).toHaveBeenCalledOnce()
  })

  /** Let a resolved tool-status read reach the top bar. */
  async function settleToolStatus(read: ReturnType<typeof vi.fn>) {
    await waitFor(() => expect(read).toHaveBeenCalled())
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
  }

  it('draws no tools button when every pipeline tool is found', async () => {
    const resize = stubTopBarResize()
    const api = createMockApi()
    const read = vi.fn(async () => ({
      capturedAt: '2026-07-22T00:00:00.000Z',
      summary: 'ok' as const,
      items: [
        'FreeSurfer',
        'QC backend',
        'Analysis Python',
        'PyBrainAge',
        'R packages',
      ].map((label) => ({ id: label, label, status: 'ok' as const })),
    }))
    api.env.toolStatus = read
    await renderWithProject(api)
    await settleToolStatus(read)

    const topBar = screen.getByRole('banner')
    // Neither layout draws a status that needs no action.
    resize(FULL_BAR_BUDGET)
    expect(topBar).toHaveAttribute('data-layout', 'full')
    expect(
      within(topBar).queryByRole('button', { name: /pipeline tools/ }),
    ).toBeNull()
    expect(within(topBar).queryByText('FreeSurfer')).toBeNull()
    resize(FULL_BAR_BUDGET - 1)
    expect(topBar).toHaveAttribute('data-layout', 'compact')
    expect(
      within(topBar).queryByRole('button', { name: /pipeline tools/ }),
    ).toBeNull()
    expect(within(topBar).queryByText(/^Tools /)).toBeNull()
  })

  /** Build the sidecar's six headline items with every tool found. */
  function assetToolStatus(assets: ToolStatusItem['status']): ToolStatus {
    const tools: ToolStatusItem[] = [
      { id: 'fs', label: 'FreeSurfer', status: 'ok' },
      { id: 'qc', label: 'QC backend', status: 'ok' },
      { id: 'analysis', label: 'Analysis Python', status: 'ok' },
      { id: 'py', label: 'PyBrainAge', status: 'ok' },
      { id: 'r', label: 'R packages', status: 'ok' },
    ]
    return {
      capturedAt: '2026-09-25T00:00:00.000Z',
      summary: assets === 'missing' || assets === 'warn' ? assets : 'ok',
      items: [
        ...tools,
        { id: 'assets', label: 'Scientific assets', status: assets },
      ],
    }
  }

  /** Stub ResizeObserver and return a resize of the top bar's border box. */
  function stubTopBarResize(): (width: number) => void {
    const callbacks: ResizeObserverCallback[] = []
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    return (width) => {
      // Call every observer in creation order. The bar replaces its observer
      // when its layout budget changes, so its newest callback runs last and
      // settles the layout.
      act(() => {
        for (const callback of callbacks) {
          callback([topBarResizeEntry(width)], {} as ResizeObserver)
        }
      })
    }
  }

  it('keeps one top-bar layout at every width around the full-layout budget', async () => {
    // The two layouts pad the bar differently. Judging the content width let
    // each layout's width select the other, so the bar flipped on every
    // observation in a 4 px band and a click never landed on it.
    const resize = stubTopBarResize()
    await renderWithProject()
    const topBar = screen.getByRole('banner')

    for (
      let width = FULL_BAR_BUDGET - 8;
      width <= FULL_BAR_BUDGET + 8;
      width += 1
    ) {
      const expected = width < FULL_BAR_BUDGET ? 'compact' : 'full'
      for (const from of [FULL_BAR_BUDGET + 100, FULL_BAR_BUDGET - 100]) {
        resize(from)
        const layouts = [0, 1, 2].map(() => {
          resize(width)
          return topBar.getAttribute('data-layout')
        })
        expect(layouts, `${width} px after ${from} px`).toEqual([
          expected,
          expected,
          expected,
        ])
      }
    }
  })

  it('draws no chip for found scientific assets and keeps the full-layout budget', async () => {
    const resize = stubTopBarResize()
    const api = createMockApi()
    const read = vi.fn(async () => assetToolStatus('ok'))
    api.env.toolStatus = read
    await renderWithProject(api)
    await settleToolStatus(read)

    const topBar = screen.getByRole('banner')
    // Found assets draw no chip of their own, so the full row fits the same
    // full-layout budget as with no assets.
    resize(FULL_BAR_BUDGET)
    expect(topBar).toHaveAttribute('data-layout', 'full')
    expect(
      within(topBar).queryByRole('button', { name: /pipeline tools/ }),
    ).toBeNull()
    expect(within(topBar).queryByText('Scientific assets')).toBeNull()

    resize(FULL_BAR_BUDGET - 1)
    expect(topBar).toHaveAttribute('data-layout', 'compact')
    expect(within(topBar).queryByText('Tools 6/6')).toBeNull()
  })

  it.each(['missing', 'warn'] as const)(
    'surfaces %s scientific assets on the top bar and only opens Diagnostics',
    async (assets) => {
      const api = createMockApi()
      const install = vi.spyOn(api.env, 'optInInstall')
      api.env.toolStatus = async () => assetToolStatus(assets)
      await renderWithProject(api)

      // A failing reviewed asset check counts its tool as not found.
      const tools = await screen.findByRole('button', {
        name: 'Open Diagnostics to fix 1 pipeline tool, 5 of 6 found',
      })
      expect(
        within(tools).getByTitle(
          'Scientific assets: The reviewed scientific assets are missing or do not verify. Open Diagnostics to restore them.',
        ),
      ).toHaveTextContent(
        assets === 'missing'
          ? 'Scientific assets missing'
          : 'Scientific assets needs setup',
      )

      fireEvent.click(tools)
      expect(
        screen.getByRole('heading', { name: 'Diagnostics' }),
      ).toBeInTheDocument()
      // The chip navigates only: the one-use install grant stays the only
      // path to a rebuild or an acquisition.
      await act(async () => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      })
      expect(install).not.toHaveBeenCalled()
    },
  )

  it('keeps the top bar compact until the full row has room for the scientific assets chip', async () => {
    const resize = stubTopBarResize()
    const api = createMockApi()
    api.env.toolStatus = async () => assetToolStatus('missing')
    await renderWithProject(api)

    const tools = await screen.findByRole('button', {
      name: 'Open Diagnostics to fix 1 pipeline tool, 5 of 6 found',
    })
    const topBar = screen.getByRole('banner')
    resize(FULL_BAR_BUDGET + ATTENTION_CHIP_ALLOWANCE - 1)
    expect(topBar).toHaveAttribute('data-layout', 'compact')
    expect(within(topBar).getByText('Tools 5/6')).toBeInTheDocument()

    resize(FULL_BAR_BUDGET + ATTENTION_CHIP_ALLOWANCE)
    expect(topBar).toHaveAttribute('data-layout', 'full')
    expect(
      within(tools).getByText('Scientific assets missing'),
    ).toBeInTheDocument()
  })

  it('draws a BrainCharts chip only while its setup needs attention', async () => {
    const resize = stubTopBarResize()
    const api = createMockApi()
    const base = assetToolStatus('ok')
    api.env.toolStatus = async () => ({
      ...base,
      summary: 'missing',
      items: [
        ...base.items,
        { id: 'braincharts', label: 'BrainCharts', status: 'missing' },
      ],
    })
    await renderWithProject(api)

    const tools = await screen.findByRole('button', {
      name: 'Open Diagnostics to fix 1 pipeline tool, 6 of 7 found',
    })
    const topBar = screen.getByRole('banner')
    resize(FULL_BAR_BUDGET + ATTENTION_CHIP_ALLOWANCE - 1)
    expect(topBar).toHaveAttribute('data-layout', 'compact')
    resize(FULL_BAR_BUDGET + ATTENTION_CHIP_ALLOWANCE)
    expect(topBar).toHaveAttribute('data-layout', 'full')
    expect(
      within(tools).getByTitle(
        'BrainCharts: The BrainCharts model or runtime is not set up. Open Diagnostics to set it up under Scientific resources.',
      ),
    ).toHaveTextContent('BrainCharts missing')
  })

  it('draws no chip for a set-up BrainCharts', async () => {
    const resize = stubTopBarResize()
    const api = createMockApi()
    const base = assetToolStatus('ok')
    const read = vi.fn(async () => ({
      ...base,
      items: [
        ...base.items,
        { id: 'braincharts', label: 'BrainCharts', status: 'ok' as const },
      ],
    }))
    api.env.toolStatus = read
    await renderWithProject(api)
    await settleToolStatus(read)

    const topBar = screen.getByRole('banner')
    resize(FULL_BAR_BUDGET)
    expect(topBar).toHaveAttribute('data-layout', 'full')
    expect(within(topBar).queryByText('BrainCharts')).toBeNull()
    expect(
      within(topBar).queryByRole('button', { name: /pipeline tools/ }),
    ).toBeNull()
  })

  it('keeps room for every attention chip it draws', async () => {
    const resize = stubTopBarResize()
    const api = createMockApi()
    const base = assetToolStatus('missing')
    api.env.toolStatus = async () => ({
      ...base,
      items: [
        ...base.items,
        { id: 'braincharts', label: 'BrainCharts', status: 'missing' },
      ],
    })
    await renderWithProject(api)

    const tools = await screen.findByRole('button', {
      name: 'Open Diagnostics to fix 2 pipeline tools, 5 of 7 found',
    })
    const topBar = screen.getByRole('banner')
    resize(FULL_BAR_BUDGET + 2 * ATTENTION_CHIP_ALLOWANCE - 1)
    expect(topBar).toHaveAttribute('data-layout', 'compact')
    resize(FULL_BAR_BUDGET + 2 * ATTENTION_CHIP_ALLOWANCE)
    expect(topBar).toHaveAttribute('data-layout', 'full')
    expect(within(tools).getByText('2 tools missing')).toHaveAttribute(
      'title',
      expect.stringMatching(/^Scientific assets: .* BrainCharts: /),
    )
  })

  it('projects every workflow host state without styling it as a tool package', async () => {
    const cases: Array<{
      state: HostState['sidecar']['state']
      attached: boolean
      label: string
    }> = [
      { state: 'unavailable', attached: false, label: 'Workflow unavailable' },
      { state: 'degraded', attached: false, label: 'Workflow degraded' },
      { state: 'starting', attached: false, label: 'Workflow starting' },
    ]

    for (const item of cases) {
      const api = createMockApi()
      const host = await packagedHost(api, {
        sidecar: {
          state: item.state,
          projectAttached: item.attached,
          detail:
            item.state === 'unavailable'
              ? 'Restore the unavailable workflow service.'
              : null,
        },
      })
      api.host.getState = async () => host
      ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
      const view = render(<App />)
      const workflow = await screen.findByRole('button', {
        name: `Review ${item.label.toLowerCase()} status in Diagnostics`,
      })
      expect(workflow).toHaveTextContent(item.label)
      expect(workflow).toHaveStyle({
        background: 'transparent',
        fontWeight: 400,
      })
      view.unmount()
    }

    // Ready without a project stays quiet in Setup, where a project opens,
    // and names the missing project elsewhere.
    const setupApi = createMockApi()
    const setupHost = await packagedHost(setupApi, {
      sidecar: { state: 'ready', projectAttached: false, detail: null },
    })
    const setupGetState = vi.fn(async () => setupHost)
    setupApi.host.getState = setupGetState
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = setupApi
    const setupView = render(<App />)
    await waitFor(() => expect(setupGetState).toHaveBeenCalled())
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    expect(
      screen.queryByRole('button', { name: /status in Diagnostics$/ }),
    ).toBeNull()
    expect(screen.queryByText('No project open')).toBeNull()
    fireEvent.keyDown(window, { key: '7' })
    expect(
      await screen.findByRole('button', {
        name: 'Review no project open status in Diagnostics',
      }),
    ).toHaveTextContent('No project open')
    setupView.unmount()

    // The normal state, ready with the project attached, draws no status.
    const api = createMockApi()
    const host = await packagedHost(api, {
      sidecar: { state: 'ready', projectAttached: true, detail: null },
    })
    const getState = vi.fn(async () => host)
    api.host.getState = getState
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)
    await waitFor(() => expect(getState).toHaveBeenCalled())
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    expect(
      screen.queryByRole('button', { name: /^Review workflow/ }),
    ).toBeNull()
    expect(screen.queryByText('Workflow ready')).toBeNull()
  })

  it('keeps compact overflow navigation keyboard- and pointer-dismissible', async () => {
    const callbacks: ResizeObserverCallback[] = []
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    // Six tabs and the More trigger need 716; a seventh needs 818.
    const layout = mockRailLayout(760)
    onTestFinished(layout.restore)
    await renderWithProject()

    act(() => {
      const entry = { contentRect: { width: 700 } } as ResizeObserverEntry
      callbacks.forEach((callback) => callback([entry], {} as ResizeObserver))
    })

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    const subjects = within(rail).getByRole('button', { name: 'Subjects' })
    fireEvent.mouseEnter(subjects)
    fireEvent.mouseLeave(subjects)
    const more = within(rail).getByRole('button', { name: 'More' })

    fireEvent.keyDown(more, { key: 'ArrowDown' })
    // The real-Electron keyboard check reads the focused element immediately
    // after the menu appears, so assert the focus without waiting for a frame.
    let menu = screen.getByRole('menu', { name: 'More workspaces' })
    expect(
      within(menu).getByRole('menuitem', { name: 'Input QC' }),
    ).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(
      within(menu).getByRole('menuitem', { name: 'Settings' }),
    ).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(
      within(menu).getByRole('menuitem', { name: 'Input QC' }),
    ).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(
      within(menu).getByRole('menuitem', { name: 'Pipeline' }),
    ).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(
      within(menu).getByRole('menuitem', { name: 'Input QC' }),
    ).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Tab' })
    await waitFor(() =>
      expect(
        screen.queryByRole('menu', { name: 'More workspaces' }),
      ).not.toBeInTheDocument(),
    )

    fireEvent.keyDown(more, { key: 'ArrowUp' })
    menu = screen.getByRole('menu', { name: 'More workspaces' })
    expect(
      within(menu).getByRole('menuitem', { name: 'Settings' }),
    ).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(more).toHaveFocus())

    fireEvent.click(more)
    await screen.findByRole('menu', { name: 'More workspaces' })
    fireEvent.pointerDown(document.body)
    await waitFor(() =>
      expect(
        screen.queryByRole('menu', { name: 'More workspaces' }),
      ).not.toBeInTheDocument(),
    )

    fireEvent.click(more)
    await screen.findByRole('menu', { name: 'More workspaces' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(more).toHaveFocus())

    fireEvent.click(more)
    menu = await screen.findByRole('menu', { name: 'More workspaces' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Pipeline' }))
    expect(
      await screen.findByRole('heading', { name: 'Pipeline' }),
    ).toBeInTheDocument()
    expect(more).toHaveAttribute('aria-current', 'page')
    // The trigger names the current screen while that screen is in the menu.
    expect(more).toHaveTextContent(/^Pipeline$/)
    expect(more).toHaveStyle({ fontWeight: 700 })
    expect(more.querySelector('svg')).not.toBeNull()

    act(() => {
      callbacks.forEach((callback) => callback([], {} as ResizeObserver))
      layout.setWidth(1_400)
      const entry = { contentRect: { width: 1_100 } } as ResizeObserverEntry
      callbacks.forEach((callback) => callback([entry], {} as ResizeObserver))
    })
    expect(within(rail).queryByRole('button', { name: 'More' })).toBeNull()
  })

  it('moves only the tabs that do not fit into the More menu', async () => {
    const callbacks: ResizeObserverCallback[] = []
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    // Eight tabs and the More trigger need 920; a ninth needs 1022.
    const layout = mockRailLayout(930)
    onTestFinished(layout.restore)
    await renderWithProject()

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    const railButtons = (): string[] =>
      within(rail)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? 'More')
    expect(railButtons()).toEqual([
      'Setup',
      'Dashboard',
      'Subjects',
      'Runs',
      'Logs',
      'QC review',
      'Input QC',
      'Pipeline',
      'More',
    ])
    const more = within(rail).getByRole('button', { name: 'More' })
    fireEvent.click(more)
    const menu = await screen.findByRole('menu', { name: 'More workspaces' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Results', 'Analysis', 'Registry', 'Diagnostics', 'Settings'])

    // Opening a screen from the menu renames the trigger and moves no tab.
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Settings' }))
    expect(
      await screen.findByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument()
    expect(more).toHaveTextContent(/^Settings$/)
    expect(within(rail).getAllByRole('button')).toHaveLength(9)
  })

  it('changes the tab count only at the width where a tab stops fitting', async () => {
    const callbacks: ResizeObserverCallback[] = []
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    const layout = mockRailLayout(1_324)
    onTestFinished(layout.restore)
    await renderWithProject()
    const resize = (width: number): void => {
      layout.setWidth(width)
      act(() => {
        callbacks.forEach((callback) => callback([], {} as ResizeObserver))
      })
    }

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    const tabCount = (): number =>
      within(rail)
        .getAllByRole('button')
        .filter((button) => !button.hasAttribute('aria-haspopup')).length

    // Thirteen tabs need 1324; below that the More trigger takes two places.
    expect(tabCount()).toBe(13)
    expect(within(rail).queryByRole('button', { name: 'More' })).toBeNull()
    resize(1_323)
    expect(tabCount()).toBe(11)
    expect(within(rail).getByRole('button', { name: 'More' })).toBeVisible()
    // The same width gives the same count from either direction.
    resize(1_226)
    expect(tabCount()).toBe(11)
    resize(1_225)
    expect(tabCount()).toBe(10)
    resize(1_226)
    expect(tabCount()).toBe(11)
    resize(1_226)
    expect(tabCount()).toBe(11)
    resize(1_324)
    expect(tabCount()).toBe(13)
  })

  it('keeps every workspace on the rail when the row has no layout', async () => {
    await renderWithProject()

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    expect(within(rail).queryByRole('button', { name: 'More' })).toBeNull()
    expect(
      within(rail).getByRole('button', { name: 'Settings' }),
    ).toBeInTheDocument()
    // The measuring probe adds no text a query or a reader could find.
    expect(within(rail).getAllByText('Settings')).toHaveLength(1)
    // Each tab reserves its bold label width, so the active tab's heavier
    // label never shifts the tabs after it.
    const settings = within(rail).getByRole('button', { name: 'Settings' })
    expect(settings.querySelector('[data-label="Settings"]')).toHaveStyle({
      fontWeight: 700,
      visibility: 'hidden',
    })
  })

  it('marks exactly one current route while the overflow menu is open', async () => {
    const callbacks: ResizeObserverCallback[] = []
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = TestResizeObserver
    const layout = mockRailLayout(760)
    onTestFinished(layout.restore)
    await renderWithProject()

    act(() => {
      const entry = { contentRect: { width: 700 } } as ResizeObserverEntry
      callbacks.forEach((callback) => callback([entry], {} as ResizeObserver))
    })

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    const more = within(rail).getByRole('button', { name: 'More' })
    fireEvent.click(more)
    const menu = await screen.findByRole('menu', { name: 'More workspaces' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Pipeline' }))
    expect(
      await screen.findByRole('heading', { name: 'Pipeline' }),
    ).toBeInTheDocument()
    expect(more).toHaveAttribute('aria-current', 'page')

    fireEvent.click(more)
    const reopened = await screen.findByRole('menu', {
      name: 'More workspaces',
    })
    const current = rail.querySelectorAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toBe(
      within(reopened).getByRole('menuitem', { name: 'Pipeline' }),
    )
    expect(more).not.toHaveAttribute('aria-current')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() =>
      expect(
        screen.queryByRole('menu', { name: 'More workspaces' }),
      ).not.toBeInTheDocument(),
    )
    expect(more).toHaveAttribute('aria-current', 'page')
  })

  it('hides the primary navigation until a project loads', () => {
    render(<App />)

    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Set up your project' }),
    ).toBeInTheDocument()
  })

  it('exposes the project route as Dashboard after loading', async () => {
    await renderWithProject()

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    expect(
      within(rail).getByRole('button', { name: 'Dashboard' }),
    ).toBeInTheDocument()
    expect(
      within(rail).queryByRole('button', { name: 'Project' }),
    ).not.toBeInTheDocument()
  })

  it('projects current runtime job state into Dashboard and Subjects', async () => {
    const cohort: Subject[] = makeMockCohort(1, 119).map((subject) => ({
      ...subject,
      qc: 'pass',
      analysisEligible: true,
      cells: subject.cells.map((cell) => ({
        ...cell,
        st: 'pending',
        startedAt: null,
        finishedAt: null,
        rc: null,
        err: null,
      })),
    }))
    const api = cohortApi(cohort)
    const staleManifest: RunManifest = {
      runId: 'run-live',
      startedAt: '2026-07-22T18:00:00.000Z',
      endedAt: '2026-07-22T18:05:00.000Z',
      user: 'operator',
      host: 'fixture-host',
      git: { repo: 'supraspina', sha: 'abc123', dirty: false },
      configSha256: '0'.repeat(64),
      steps: [
        {
          id: 1,
          key: 'recon',
          status: 'done',
          subjects: 1,
          failed: 0,
          durationSec: 300,
        },
      ],
      tools: {},
    }
    api.manifest.list = async () => ({
      items: [staleManifest],
      nextCursor: null,
    })
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    api.runtime.bootstrap = vi.fn(async ({ project }) => {
      const liveJob: Job = {
        id: 'job-live-recon',
        runId: 'run-live',
        projectId: project.projectId,
        projectEpoch: project.epoch,
        sidecarGeneration: host.sidecar.generation,
        stepKey: 'recon',
        subjectId: cohort[0]!.id,
        startedAt: 110,
        endedAt: null,
        exitCode: null,
        cmd: 'recon fixture',
        stdoutPath: 'stdout.log',
        stderrPath: 'stderr.log',
        envSnapshotPath: 'env.json',
        configSnapshotPath: 'config.json',
        status: 'running',
      }
      return {
        project,
        sidecarGeneration: host.sidecar.generation,
        sequence: 1,
        runs: [
          {
            runId: 'run-live',
            projectId: project.projectId,
            projectEpoch: project.epoch,
            status: 'running' as const,
            startedAt: 100,
            endedAt: null,
            dryRun: false,
            durable: true,
            selectedSubjectIds: [cohort[0]!.id],
            acknowledgements: {
              includeDeferredAndUnreviewedQc: false,
              acknowledgeMemoryAdvisory: false,
            },
            summary: {
              planned: 1,
              started: 1,
              waiting: 0,
              blocked: 0,
              skipped: 0,
              message: 'running',
            },
          },
        ],
        jobs: [liveJob],
        logTail: [],
        provision: null,
      }
    })

    await renderWithProject(api)

    expect(
      await screen.findByRole('img', { name: 'Reconstruction: running' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^Open running subjects \(Running: 1\)\.$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: 'Cohort progress: 0 done, 0 out of date, 0 partly done, 1 running, 0 failed, and 0 pending of 1 subject',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: 'Run in progress' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('img', { name: 'Run completed' }),
    ).not.toBeInTheDocument()

    const navigation = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(
      within(navigation).getByRole('button', { name: 'Subjects' }),
    )
    expect(
      await screen.findByRole('button', {
        name: /^Reconstruction for .*: running,/,
      }),
    ).toBeInTheDocument()
  })

  it('mounts every gated workspace and routes a subject row into QC review', async () => {
    const cohort = makeMockCohort(2, 441).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    await renderWithProject(cohortApi(cohort))
    const rail = screen.getByRole('navigation', { name: 'Primary' })

    for (const label of [
      'Runs',
      'Pipeline',
      'Results',
      'Analysis',
      'Settings',
      'QC review',
      'Input QC',
      'Subjects',
    ]) {
      const route = within(rail).getByRole('button', { name: label })
      fireEvent.click(route)
      expect(route).toHaveAttribute('aria-current', 'page')
    }
    expect(within(rail).getAllByRole('button')).toHaveLength(13)

    const openSubject = await screen.findByRole('button', {
      name: `Open ${cohort[0]!.id} in QC review`,
    })
    fireEvent.click(openSubject)
    expect(
      within(rail).getByRole('button', { name: 'QC review' }),
    ).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
  })

  it('opens Analysis after Results and reads the catalog through the API', async () => {
    const api = await renderWithProject(cohortApi(makeMockCohort(2, 441)))
    const catalog = vi.spyOn(api.groupAnalysis, 'catalog')
    const rail = screen.getByRole('navigation', { name: 'Primary' })
    const labels = within(rail)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(labels.indexOf('Analysis')).toBe(labels.indexOf('Results') + 1)

    fireEvent.click(within(rail).getByRole('button', { name: 'Analysis' }))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Analysis' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('img', { name: /^Forest plot: / }),
    ).toBeInTheDocument()
    expect(catalog).toHaveBeenCalledWith({
      project: expect.objectContaining({ projectId: expect.any(String) }),
    })
  })

  it('keeps the shell gated through the wizard until a project is created', () => {
    render(<App />)
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Draft study' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Run all/ }),
    ).not.toBeInTheDocument()
  })

  it('does not run or jump routes from the keymap with no project loaded', () => {
    const run = vi.fn(async () => undefined)
    const api = createMockApi()
    api.pipeline.runWorkflow =
      run as unknown as SupraspinaApi['pipeline']['runWorkflow']
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'r' })
    fireEvent.keyDown(window, { key: 'R' })
    fireEvent.keyDown(window, { key: '1' })

    expect(run).not.toHaveBeenCalled()
    expect(
      screen.getByRole('heading', { name: 'Set up your project' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
  })

  it('unlocks the shell when the wizard create flow completes', async () => {
    render(<App />)
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Made study' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/made' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // Keep pre-create environment verification project-scoped, and show no
    // invented tool results.
    await screen.findByText(
      /project-scoped checks run after this project is created/i,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() =>
      expect(
        screen.getByRole('navigation', { name: 'Primary' }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })

  it('enables the New/Open toolbar but disables Save until a project loads', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: 'New' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Open a saved project' }),
    ).toBeEnabled()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    expect(save).toHaveAttribute('title', 'Create or open a project first.')
  })

  it('opens a recent project from the single toolbar menu', async () => {
    localStorage.setItem(
      'supraspinaRecentProjects',
      JSON.stringify([
        {
          name: 'Pilot cohort',
          path: '/data/projects/pilot/supraspina.project.json',
          openedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    )
    const api = createMockApi()
    const openSpy = vi.fn(
      async ({ epoch }: { path: string; epoch: number }) => ({
        ...LOADED_PROJECT_RESULT,
        project: { ...LOADED_PROJECT_RESULT.project, epoch },
      }),
    )
    api.project.open = openSpy as unknown as SupraspinaApi['project']['open']
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open a saved project',
      }),
    )
    const openTrigger = screen.getByRole('button', {
      name: 'Open a saved project',
    })
    const openMenu = screen.getByRole('menu', { name: 'Open project' })
    const browse = screen.getByRole('menuitem', {
      name: 'Open project file...',
    })
    const recent = screen.getByRole('menuitem', { name: /Pilot cohort/ })
    await waitFor(() => expect(browse).toHaveFocus())
    fireEvent.keyDown(openMenu, { key: 'End' })
    expect(recent).toHaveFocus()
    fireEvent.keyDown(openMenu, { key: 'Home' })
    expect(browse).toHaveFocus()
    fireEvent.keyDown(openMenu, { key: 'ArrowDown' })
    expect(recent).toHaveFocus()
    fireEvent.keyDown(openMenu, { key: 'Escape' })
    await waitFor(() => expect(openTrigger).toHaveFocus())
    expect(
      screen.queryByRole('menu', { name: 'Open project' }),
    ).not.toBeInTheDocument()
    fireEvent.keyDown(openTrigger, { key: 'ArrowUp' })
    const reopenedRecent = await screen.findByRole('menuitem', {
      name: /Pilot cohort/,
    })
    await waitFor(() => expect(reopenedRecent).toHaveFocus())
    fireEvent.click(reopenedRecent)
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith({
        path: '/data/projects/pilot/supraspina.project.json',
        epoch: expect.any(Number),
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('navigation', { name: 'Primary' }),
      ).toBeInTheDocument(),
    )
  })

  it('dismisses the Open menu by toggle, Escape, and outside click and reports picker errors', async () => {
    const api = createMockApi()
    const chooseFile = vi
      .fn<SupraspinaApi['fs']['chooseFile']>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce('Retry because the project picker failed.')
    api.fs.chooseFile = chooseFile
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)

    const open = screen.getByRole('button', { name: 'Open a saved project' })
    fireEvent.mouseEnter(open)
    fireEvent.mouseLeave(open)
    fireEvent.click(open)
    expect(
      screen.getByRole('menu', { name: 'Open project' }),
    ).toBeInTheDocument()
    fireEvent.click(open)
    expect(
      screen.queryByRole('menu', { name: 'Open project' }),
    ).not.toBeInTheDocument()

    fireEvent.click(open)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() =>
      expect(
        screen.queryByRole('menu', { name: 'Open project' }),
      ).not.toBeInTheDocument(),
    )

    fireEvent.click(open)
    fireEvent.mouseDown(document.body)
    await waitFor(() =>
      expect(
        screen.queryByRole('menu', { name: 'Open project' }),
      ).not.toBeInTheDocument(),
    )

    fireEvent.click(open)
    const cancelled = screen.getByRole('menuitem', {
      name: 'Open project file...',
    })
    fireEvent.mouseEnter(cancelled)
    fireEvent.mouseLeave(cancelled)
    fireEvent.click(cancelled)
    await waitFor(() => expect(chooseFile).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(open)
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Open project file...' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Retry because the project picker failed.',
    )
  })

  it('states a picker error as written, keeping the underscores of a path', async () => {
    const api = createMockApi()
    api.fs.chooseFile = vi
      .fn<SupraspinaApi['fs']['chooseFile']>()
      .mockRejectedValueOnce(
        new Error('Could not read /data/my_study/supraspina.project.json.'),
      )
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Open a saved project' }),
    )
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Open project file...' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not read /data/my_study/supraspina.project.json.',
    )
  })

  it('titles a launch error as written, keeping the underscores of a tool name', async () => {
    // Humanizing the title would turn "mri_surf2surf" into "Mri surf2surf".
    const cohort = makeMockCohort(2, 527).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    vi.spyOn(api.pipeline, 'planWorkflow').mockRejectedValueOnce(
      new Error('mri_surf2surf ended with exit code 255.'),
    )
    await renderWithProject(api)

    await launchRunAllFromDock('Run all 2')
    const alert = await screen.findByRole('alert')
    // The title is the message, so the message shows once.
    expect(
      within(alert).getAllByText('mri_surf2surf ended with exit code 255.'),
    ).toHaveLength(1)
    expect(screen.queryByText(/Mri surf2surf/)).toBeNull()
  })

  it('states why Save is disabled for an unedited project', async () => {
    // The title states a fact rather than an order: the operator has
    // nothing to do.
    await renderWithProject()
    const save = screen.getByRole('button', {
      name: 'Save',
    })
    expect(save).toBeDisabled()
    expect(save).toHaveAttribute('title', 'The project has no unsaved changes.')
  })

  describe('the dock Resume failed and Cancel titles', () => {
    const failedAt = Date.parse('2026-09-26T00:56:00.000Z')

    /** Build a one-subject analysis cohort behind an attached workflow service. */
    async function attachedCohortApi(): Promise<{
      api: SupraspinaApi
      subjectId: string
    }> {
      const cohort = makeMockCohort(1, 531).map((subject) => ({
        ...subject,
        qc: 'pass' as const,
        analysisEligible: true,
        unavailableReason: null,
      }))
      const api = cohortApi(cohort)
      const host = await packagedHost(api, {
        sidecar: { projectAttached: true },
      })
      api.host.getState = async () => host
      return { api, subjectId: cohort[0]!.id }
    }

    /** Build a durable, finished one-job run of the loaded project. */
    function durableRun(
      runId: string,
      status: RunSnapshot['status'],
      startedAt: number,
      epoch: number,
    ): RunSnapshot {
      return {
        runId,
        projectId: LOADED_PROJECT_RESULT.project.projectId,
        projectEpoch: epoch,
        status,
        startedAt,
        endedAt: startedAt + 60_000,
        dryRun: false,
        durable: true,
        acknowledgements: {
          includeDeferredAndUnreviewedQc: false,
          acknowledgeMemoryAdvisory: false,
        },
        summary: {
          planned: 1,
          started: 1,
          waiting: 0,
          blocked: 0,
          skipped: 0,
          message: status,
        },
      }
    }

    /** Build the runtime snapshot of a failed recon run, plus later runs. */
    function failedRunSnapshot(
      project: RuntimeSnapshot['project'],
      subjectId: string,
      laterRuns: readonly RunSnapshot[] = [],
      failure: Partial<Job> = {},
    ): RuntimeSnapshot {
      const failedJob: Job = {
        id: 'job-failed',
        runId: 'run-failed',
        nodeId: 'node-failed',
        projectId: project.projectId,
        projectEpoch: project.epoch,
        sidecarGeneration: 1,
        stepKey: 'recon',
        subjectId,
        startedAt: failedAt,
        endedAt: failedAt + 1,
        exitCode: 1,
        cmd: 'recon-all',
        stdoutPath: '',
        stderrPath: '',
        envSnapshotPath: '',
        configSnapshotPath: '',
        status: 'failed',
        durable: true,
        ...failure,
      }
      return {
        project,
        sidecarGeneration: 1,
        sequence: 1,
        runs: [
          durableRun('run-failed', 'failed', failedAt, project.epoch),
          ...laterRuns,
        ],
        jobs: [failedJob],
        logTail: [],
        provision: null,
      }
    }

    it('states why the dock holds Resume failed and Cancel', async () => {
      // The disabled Resume failed names the later run that superseded the
      // failure, as Runs and Subjects do, and Cancel states that no run is
      // active rather than giving an order.
      const { api, subjectId } = await attachedCohortApi()
      api.runtime.bootstrap = vi.fn(async ({ project }) =>
        failedRunSnapshot(project, subjectId, [
          durableRun('run-later', 'done', failedAt + 120_000, project.epoch),
        ]),
      )
      await renderWithProject(api)

      const dock = screen.getByRole('contentinfo')
      const resume = within(dock).getByRole('button', {
        name: 'Resume failed',
      })
      await waitFor(() =>
        expect(resume.getAttribute('title')).toMatch(
          /^Nothing to resume: run-later finished after the failed run of .+\.$/,
        ),
      )
      expect(resume).toBeDisabled()
      const cancel = within(dock).getByRole('button', { name: 'Cancel' })
      expect(cancel).toBeDisabled()
      // The shortcut follows the reason in the same tooltip.
      expect(cancel).toHaveAttribute('title', 'No run is active. Shortcut: C.')
      expect(resume.getAttribute('title')).toMatch(/\. Shortcut: Shift\+R\.$/)
    })

    it('keeps Resume failed secondary for an input limit and says why', async () => {
      // A Brain FOV refusal follows from the source image, so a resume
      // repeats the same check and is not offered as the primary action.
      const { api, subjectId } = await attachedCohortApi()
      api.runtime.bootstrap = vi.fn(async ({ project }) =>
        failedRunSnapshot(project, subjectId, [], {
          stepKey: 'brainfov',
          terminalReason: 'Keep the brain mask away from every crop face.',
        }),
      )
      await renderWithProject(api)

      const dock = screen.getByRole('contentinfo')
      const resume = within(dock).getByRole('button', {
        name: 'Resume failed',
      })
      await waitFor(() => expect(resume).toBeEnabled())
      expect(resume).toHaveAttribute(
        'title',
        'Input limit: The brain reaches the edge of the source image, so no crop can keep the required margin; the scan does not cover the whole brain. Resume repeats the same check on the same input. Shortcut: Shift+R.',
      )
      // A primary button has no border; a secondary one has its outline.
      expect(resume.style.borderStyle).toBe('solid')
      // Run all takes the one accent instead.
      const runAll = within(dock).getByRole('button', { name: /^Run all/ })
      expect(runAll).toBeEnabled()
      expect(runAll.style.borderStyle).not.toBe('solid')
    })

    it('keeps Resume failed primary for any other failure', async () => {
      const { api, subjectId } = await attachedCohortApi()
      api.runtime.bootstrap = vi.fn(async ({ project }) =>
        failedRunSnapshot(project, subjectId, [], {
          terminalReason: 'The process exited with code 1.',
        }),
      )
      await renderWithProject(api)

      const dock = screen.getByRole('contentinfo')
      const resume = within(dock).getByRole('button', { name: 'Resume failed' })
      await waitFor(() => expect(resume).toBeEnabled())
      expect(resume.style.borderStyle).not.toBe('solid')
      expect(resume.getAttribute('title') ?? '').not.toMatch(/Input limit/)
      // Exactly one accent button: Run all steps back to secondary.
      const runAll = within(dock).getByRole('button', { name: /^Run all/ })
      expect(runAll).toBeEnabled()
      expect(runAll.style.borderStyle).toBe('solid')
    })

    it('claims nothing to resume or cancel only once the runtime restore answers', async () => {
      // Until the runtime bootstrap answers, the dock cannot know that no
      // run is waiting for recovery or active: the restore may bring back a
      // failed run to resume.
      const { api, subjectId } = await attachedCohortApi()
      let answer: ((snapshot: RuntimeSnapshot) => void) | undefined
      let restoredProject: RuntimeSnapshot['project'] | undefined
      api.runtime.bootstrap = vi.fn(
        ({ project }) =>
          new Promise<RuntimeSnapshot>((resolve) => {
            restoredProject = project
            answer = resolve
          }),
      )
      await renderWithProject(api)

      // The cohort is counted before the restore answers, so the dock names
      // the restore it waits on.
      const dock = screen.getByRole('contentinfo')
      await waitFor(() =>
        expect(within(dock).getByRole('status')).toHaveTextContent(
          'Restoring run history...',
        ),
      )
      const resume = within(dock).getByRole('button', {
        name: 'Resume failed',
      })
      const cancel = within(dock).getByRole('button', { name: 'Cancel' })
      expect(resume).toBeDisabled()
      expect(resume.getAttribute('title') ?? '').not.toMatch(
        /^Nothing to resume/,
      )
      expect(cancel).toBeDisabled()
      // Only the shortcut, with no claim that no run is active.
      expect(cancel).toHaveAttribute('title', 'Shortcut: C.')

      await act(async () => {
        answer!(failedRunSnapshot(restoredProject!, subjectId))
        await Promise.resolve()
      })
      await waitFor(() => expect(resume).toBeEnabled())
      expect(resume.getAttribute('title') ?? '').not.toMatch(
        /^Nothing to resume/,
      )
      expect(cancel).toHaveAttribute('title', 'No run is active. Shortcut: C.')
    })

    it('claims nothing to resume or cancel when the runtime restore fails', async () => {
      // An unverified project is never idle: with no accepted runtime
      // snapshot the dock cannot know that no failure waits or no run is
      // active, so neither title says so.
      const { api } = await attachedCohortApi()
      api.runtime.bootstrap = vi.fn(async () => {
        throw new Error('Runtime state could not be restored.')
      })
      await renderWithProject(api)

      const dock = screen.getByRole('contentinfo')
      await waitFor(() => {
        expect(
          within(dock).queryByText('Loading the cohort...'),
        ).not.toBeInTheDocument()
        expect(
          within(dock).queryByText('Restoring run history...'),
        ).not.toBeInTheDocument()
      })
      const resume = within(dock).getByRole('button', {
        name: 'Resume failed',
      })
      expect(resume).toBeDisabled()
      expect(resume.getAttribute('title') ?? '').not.toMatch(
        /^Nothing to resume/,
      )
      const cancel = within(dock).getByRole('button', { name: 'Cancel' })
      expect(cancel).toBeDisabled()
      expect(cancel.getAttribute('title') ?? '').not.toMatch(/No run is active/)
    })

    it('holds Run all with the reason while a live run is active', async () => {
      // The sidecar refuses a start while a run is active, so the dock must
      // not open a launch confirmation for one.
      const { api, subjectId } = await attachedCohortApi()
      api.runtime.bootstrap = vi.fn(async ({ project }) => {
        const snapshot = failedRunSnapshot(project, subjectId)
        const run = durableRun('run-active', 'running', failedAt, project.epoch)
        return {
          ...snapshot,
          runs: [{ ...run, endedAt: null }],
          jobs: snapshot.jobs.map((job) => ({
            ...job,
            runId: 'run-active',
            endedAt: null,
            exitCode: null,
            status: 'running' as const,
          })),
        }
      })
      await renderWithProject(api, {
        ...LOADED_PROJECT,
        runtime: { ...LOADED_PROJECT.runtime, dryRun: false },
      })

      const dock = screen.getByRole('contentinfo')
      const cancel = within(dock).getByRole('button', { name: 'Cancel' })
      await waitFor(() => expect(cancel).toBeEnabled())
      const runAll = within(dock).getByRole('button', { name: /^Run all/ })
      expect(runAll).toBeDisabled()
      expect(runAll).toHaveAttribute(
        'title',
        'A run is active, and another starts only after it ends. Shortcut: R.',
      )
      // Run step... still opens Runs, where the active run is watched.
      expect(
        within(dock).getByRole('button', { name: 'Run step...' }),
      ).toBeEnabled()

      // The r shortcut reaches the same Run all: it states the hold
      // instead of opening a launch confirmation for a refused start.
      fireEvent.keyDown(window, { key: 'r' })
      expect(
        await screen.findByText(
          'A run is active, and another starts only after it ends.',
          { selector: ':not(button)' },
        ),
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('dialog', { name: 'Review the run plan?' }),
      ).not.toBeInTheDocument()
    })
  })

  it('keeps a dirty project recoverable after a toolbar Save failure', async () => {
    const api = cohortApi(makeMockCohort(1, 211))
    const saveProject = vi.spyOn(api.project, 'save')
    saveProject.mockRejectedValueOnce('Free disk space before saving.')
    await renderWithProject(api)

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Pipeline' }))
    const stage = await screen.findByRole('switch', {
      name: 'Optional defacing stage',
    })
    fireEvent.click(stage)

    const toolbarSave = await waitFor(() => {
      const button = screen
        .getAllByRole('button', { name: 'Save' })
        .find((candidate) => candidate.title === 'Save the project.')
      expect(button).toBeDefined()
      return button!
    })
    expect(toolbarSave).toBeEnabled()
    fireEvent.click(toolbarSave)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Free disk space before saving.',
    )
    expect(toolbarSave).toBeEnabled()

    fireEvent.click(toolbarSave)
    await waitFor(() => expect(saveProject).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(toolbarSave).toBeDisabled())
    expect(toolbarSave).toHaveAttribute(
      'title',
      'The project has no unsaved changes.',
    )
  })

  it('states a failed Save below the toolbar until it is dismissed or the project is edited', async () => {
    const api = cohortApi(makeMockCohort(1, 211))
    const saveProject = vi.spyOn(api.project, 'save')
    const failure = new Error(
      'Check permissions and free disk space, then retry the local file operation.',
    )
    saveProject.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
    await renderWithProject(api)

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Pipeline' }))
    const stage = await screen.findByRole('switch', {
      name: 'Optional defacing stage',
    })
    fireEvent.click(stage)
    const toolbar = screen.getByRole('navigation', { name: 'Project actions' })
    const toolbarSave = within(toolbar).getByRole('button', { name: 'Save' })

    fireEvent.click(toolbarSave)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'The project was not saved. Check permissions and free disk space, then retry the local file operation.',
    )
    // The error takes a row of its own below the toolbar: inside the Project
    // actions nav it squeezed the Primary navigation to clipped labels.
    expect(toolbar).not.toContainElement(alert)
    expect(rail).not.toContainElement(alert)

    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss the project save error' }),
    )
    expect(screen.queryByRole('alert')).toBeNull()

    // A later change to the state the save failed on clears the error too.
    fireEvent.click(toolbarSave)
    await screen.findByRole('alert')
    fireEvent.click(stage)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('leaves a freshly opened project clean', async () => {
    await renderWithProject()
    expect(screen.queryByText('UNSAVED')).not.toBeInTheDocument()
  })

  it('hides the run dock until a project loads', () => {
    render(<App />)
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
  })

  it('mounts the run dock after a project loads', async () => {
    await renderWithProject()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })

  it('orders the dock actions with Run all as the one accent at the trailing edge', async () => {
    const cohort = makeMockCohort(2, 527).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    await renderWithProject(cohortApi(cohort))
    const dock = screen.getByRole('contentinfo')
    const runAll = await within(dock).findByRole('button', {
      name: 'Run all 2',
    })
    await waitFor(() => expect(runAll).toBeEnabled())

    const actions = within(dock)
      .getAllByRole('button')
      .filter((button) =>
        /^(Add subject|Cancel|Resume failed|Run step\.\.\.|Run all)/.test(
          button.getAttribute('aria-label') ?? '',
        ),
      )
    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Add subject',
      'Cancel',
      'Resume failed',
      'Run step...',
      runAll.getAttribute('aria-label'),
    ])
    // Run all is the only accent button while no failed run waits: a primary
    // button has no border, and every other action keeps its outline.
    expect(runAll.style.borderStyle).not.toBe('solid')
    for (const button of actions.slice(0, -1)) {
      expect(button.style.borderStyle).toBe('solid')
    }
    // Shortcuts live in the tooltips, not as key caps inside the buttons.
    expect(runAll).toHaveTextContent(/^Run all( \d+)?$/)
    expect(runAll.getAttribute('title')).toMatch(/Shortcut: R\.$/)
    expect(
      within(dock).getByRole('button', { name: 'Cancel' }),
    ).toHaveAttribute('title', expect.stringMatching(/Shortcut: C\.$/))
    expect(
      within(dock).getByRole('button', { name: 'Resume failed' }),
    ).toHaveTextContent(/^Resume failed$/)
  })

  it('draws the dock run buttons without the accent on Input QC, whose Approve leads', async () => {
    await renderWithProject()
    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Input QC' }))
    const dock = screen.getByRole('contentinfo')
    const runAll = await within(dock).findByRole('button', {
      name: /^Run all/,
    })
    expect(runAll.style.borderStyle).toBe('solid')
    expect(
      within(dock).getByRole('button', { name: 'Resume failed' }).style
        .borderStyle,
    ).toBe('solid')
  })

  it('draws no dock on Runs, which owns the run controls and Add subject', async () => {
    await renderWithProject()
    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Runs' }))
    await screen.findByRole('heading', { name: 'Runs' })
    expect(screen.queryByRole('contentinfo')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add subject' }))
    expect(
      await screen.findByRole('heading', { name: 'Registry' }),
    ).toBeInTheDocument()
  })

  it('gates the run dock and the r keymap on a loaded project with no subjects', async () => {
    // Disable every run entry point for a loaded, empty cohort.
    const api = createMockApi()
    const mockOpen = api.project.open
    api.project.open = async (request) => {
      await mockOpen(request)
      return {
        ...LOADED_PROJECT_RESULT,
        project: { ...LOADED_PROJECT_RESULT.project, epoch: request.epoch },
      }
    }
    api.fs.chooseFile = async () =>
      '/data/projects/demo/supraspina.project.json'
    const run = vi.fn(async () => undefined)
    api.pipeline.runWorkflow =
      run as unknown as SupraspinaApi['pipeline']['runWorkflow']
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Open a saved project' }),
    )
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Open project file...' }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('navigation', { name: 'Primary' }),
      ).toBeInTheDocument(),
    )
    const dock = screen.getByRole('contentinfo')
    // One neutral line names the fix, without the warning triangle, and the
    // disabled run buttons give the same sentence as their reason.
    const status = await within(dock).findByRole('status')
    expect(status).toHaveTextContent(/^Add subjects to run\.$/)
    expect(status.querySelector('svg')).toBeNull()
    expect(
      within(dock).getByTitle('No analysis-cohort subjects'),
    ).toHaveTextContent(/^No subjects$/)
    const runAll = within(dock).getByRole('button', { name: /^Run all/ })
    expect(runAll).toBeDisabled()
    expect(runAll).toHaveAttribute('title', 'Add subjects to run. Shortcut: R.')
    expect(
      within(dock).getByRole('button', { name: 'Run step...' }),
    ).toHaveAttribute('title', 'Add subjects to run.')
    fireEvent.keyDown(window, { key: 'r' })
    expect(run).not.toHaveBeenCalled()
  })

  it('gates the run dock precisely when every discovered subject has QC Fail', async () => {
    const api = createMockApi()
    const mockOpen = api.project.open
    api.project.open = async (request) => {
      await mockOpen(request)
      return {
        ...LOADED_PROJECT_RESULT,
        project: { ...LOADED_PROJECT_RESULT.project, epoch: request.epoch },
      }
    }
    api.subjects.discover = async () =>
      makeMockCohort(2, 71).map((subject) => ({
        ...subject,
        qc: 'fail' as const,
        analysisEligible: false,
        unavailableReason: 'Change the QC Fail verdict before analysis.',
      }))
    api.fs.chooseFile = async () =>
      '/data/projects/demo/supraspina.project.json'
    const run = vi.spyOn(api.pipeline, 'runWorkflow')
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Open a saved project' }),
    )
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Open project file...' }),
    )
    await waitFor(() =>
      expect(screen.getByRole('contentinfo')).toBeInTheDocument(),
    )

    const dock = screen.getByRole('contentinfo')
    expect(
      within(dock).getByText(
        'Change at least one QC Fail verdict before running.',
      ),
    ).toBeInTheDocument()
    expect(within(dock).getByRole('button', { name: 'Run all' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const palette = screen.getByRole('dialog', { name: 'Command palette' })
    expect(
      within(palette).queryByRole('option', { name: 'Run all' }),
    ).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'r' })
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
  })

  describe('while subject discovery has not answered', () => {
    /**
     * Hold every discovery request until the test answers it, as a slow
     * discovery of a large project does after launch.
     */
    function deferDiscovery(api: SupraspinaApi): (rows: Subject[]) => void {
      const waiting: Array<(rows: Subject[]) => void> = []
      api.subjects.discover = () =>
        new Promise<Subject[]>((resolve) => {
          waiting.push(resolve)
        })
      return (rows) => {
        for (const resolve of waiting.splice(0)) resolve(rows)
      }
    }

    function eligibleCohort(n: number): Subject[] {
      return makeMockCohort(n, 167).map((subject) => ({
        ...subject,
        qc: 'pass' as const,
        analysisEligible: true,
        unavailableReason: null,
      }))
    }

    /**
     * Hold every runtime restore until the test releases it, as the lab
     * host's restore of its 37 runs held until about 56 s after each launch.
     */
    function deferRuntimeRestore(api: SupraspinaApi): () => void {
      const restore = api.runtime.bootstrap
      const waiting: Array<() => void> = []
      api.runtime.bootstrap = (request) =>
        new Promise<RuntimeSnapshot>((resolve, reject) => {
          waiting.push(() => {
            restore(request).then(resolve, reject)
          })
        })
      return () => {
        for (const release of waiting.splice(0)) release()
      }
    }

    function dockScopeChip(title: string): HTMLElement {
      return within(screen.getByRole('contentinfo')).getByTitle(title)
    }

    /** The dock's status line, drawn with the warning triangle or not. */
    function dockStatus(): { text: string; warning: boolean } {
      const status = within(screen.getByRole('contentinfo')).getByRole('status')
      return {
        text: status.textContent ?? '',
        // The warning triangle is the line's only drawn icon; a load shows
        // the pulsing status dot instead.
        warning: status.querySelector('svg') !== null,
      }
    }

    async function expectCohortLoading(): Promise<void> {
      const dock = await screen.findByRole('contentinfo')
      // The chip holds the tiles' placeholder, not "No analysis-cohort
      // subjects", and names what it stands for in its tooltip.
      expect(
        dockScopeChip('The analysis cohort is still loading.'),
      ).toHaveTextContent(/^--$/)
      expect(
        within(dock).queryByText('No analysis-cohort subjects'),
      ).not.toBeInTheDocument()
      expect(
        within(dock).getByRole('button', { name: 'Run all' }),
      ).toBeDisabled()
      expect(within(dock).getByRole('status')).toHaveTextContent(
        'Loading the cohort...',
      )
      expect(
        within(dock).queryByText('Add subjects to run.'),
      ).not.toBeInTheDocument()
      expect(
        within(dock).queryByText(emptyAnalysisCohortReason([])),
      ).not.toBeInTheDocument()
      // The Dashboard tile draws "--" and names the load, not "Subjects 0".
      const tile = screen.getByRole('button', {
        name: 'Open all subjects (Subjects: loading).',
      })
      expect(tile).toHaveTextContent(/^Subjects--$/)
      // The tiles' polite live line states the load as a fact.
      expect(
        screen.getByText('Subject status counts are loading.'),
      ).toHaveAttribute('aria-live', 'polite')
    }

    it('holds the dock scope, Run all and the Subjects tile as loading, then counts the answered cohort', async () => {
      const api = createMockApi()
      const answer = deferDiscovery(api)
      const run = vi.spyOn(api.pipeline, 'runWorkflow')
      const plan = vi.spyOn(api.pipeline, 'planWorkflow')
      await renderWithProject(api)

      await expectCohortLoading()
      // The r shortcut neither launches nor posts a false empty-cohort notice.
      fireEvent.keyDown(window, { key: 'r' })
      await act(async () => {
        await Promise.resolve()
      })
      expect(run).not.toHaveBeenCalled()
      expect(plan).not.toHaveBeenCalled()
      expect(
        screen.queryByText(emptyAnalysisCohortReason([])),
      ).not.toBeInTheDocument()

      await act(async () => {
        answer(eligibleCohort(82))
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(dockScopeChip('All 82 subjects')).toHaveTextContent(
          /^All 82 subjects$/,
        ),
      )
      const dock = screen.getByRole('contentinfo')
      expect(
        within(dock).getByRole('button', { name: 'Run all 82' }),
      ).toBeInTheDocument()
      expect(
        within(dock).queryByText('Loading the cohort...'),
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', {
          name: 'Open all subjects (Subjects: 82).',
        }),
      ).toHaveTextContent(/^Subjects82$/)
    })

    it('states an empty analysis cohort only once discovery answers with none', async () => {
      const api = createMockApi()
      const answer = deferDiscovery(api)
      await renderWithProject(api)

      await expectCohortLoading()

      await act(async () => {
        answer([])
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(dockScopeChip('No analysis-cohort subjects')).toHaveTextContent(
          /^No subjects$/,
        ),
      )
      // An empty cohort reads as one neutral line that names the fix.
      expect(dockStatus()).toEqual({
        text: 'Add subjects to run.',
        warning: false,
      })
      expect(
        within(screen.getByRole('contentinfo')).getByRole('button', {
          name: 'Run all',
        }),
      ).toBeDisabled()
      // An empty project shows the empty state instead of a row of zeros.
      expect(
        screen.queryByRole('button', {
          name: 'Open all subjects (Subjects: 0).',
        }),
      ).toBeNull()
      expect(
        within(screen.getByRole('main')).getByText('No subjects found yet.'),
      ).toBeInTheDocument()
    })

    it('states the run history restore, not the cohort load, once discovery counts the cohort', async () => {
      const api = createMockApi()
      const host = await packagedHost(api, {
        sidecar: { projectAttached: true },
      })
      api.host.getState = async () => host
      const answer = deferDiscovery(api)
      const release = deferRuntimeRestore(api)
      await renderWithProject(api)

      // While the cohort itself is unknown the dock says so, drawn as a
      // load rather than a warning.
      await expectCohortLoading()
      expect(dockStatus()).toEqual({
        text: 'Loading the cohort...',
        warning: false,
      })

      // Discovery counts the cohort while the run history still restores,
      // which can take tens of seconds on a large project: the line names
      // that wait instead of the finished cohort load.
      await act(async () => {
        answer(eligibleCohort(82))
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(dockScopeChip('All 82 subjects')).toHaveTextContent(
          /^All 82 subjects$/,
        ),
      )
      const dock = screen.getByRole('contentinfo')
      expect(
        within(dock).getByRole('button', { name: 'Run all 82' }),
      ).toBeDisabled()
      expect(dockStatus()).toEqual({
        text: 'Restoring run history...',
        warning: false,
      })
      expect(
        within(dock).queryByText('Loading the cohort...'),
      ).not.toBeInTheDocument()

      await act(async () => {
        release()
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(within(dock).queryByRole('status')).not.toBeInTheDocument(),
      )
      await waitFor(() =>
        expect(
          within(dock).getByRole('button', { name: 'Run all 82' }),
        ).toBeEnabled(),
      )
    })

    it('states an empty counted cohort while the run history restores', async () => {
      const api = createMockApi()
      const host = await packagedHost(api, {
        sidecar: { projectAttached: true },
      })
      api.host.getState = async () => host
      const answer = deferDiscovery(api)
      deferRuntimeRestore(api)
      await renderWithProject(api)
      await expectCohortLoading()

      await act(async () => {
        answer([])
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(dockScopeChip('No analysis-cohort subjects')).toHaveTextContent(
          /^No subjects$/,
        ),
      )
      // The counted cohort is empty whatever the restore finds, so the dock
      // states that fix rather than the restore.
      expect(dockStatus()).toEqual({
        text: 'Add subjects to run.',
        warning: false,
      })
      expect(
        within(screen.getByRole('contentinfo')).getByRole('button', {
          name: 'Run all',
        }),
      ).toBeDisabled()
    })

    function openRoute(label: string): void {
      const rail = screen.getByRole('navigation', { name: 'Primary' })
      fireEvent.click(within(rail).getByRole('button', { name: label }))
    }

    /** The Runs header's scope value beside its "Target" label. */
    function runsTarget(): HTMLElement {
      const value = screen.getByText('Target').nextElementSibling
      if (!(value instanceof HTMLElement)) {
        throw new Error('Render the Runs header target value.')
      }
      return value
    }

    it('holds the Runs target and run cards as loading, then counts the answered cohort', async () => {
      const api = createMockApi()
      const answer = deferDiscovery(api)
      await renderWithProject(api)
      openRoute('Runs')

      // On Runs the dock hides its own chip, so the header target is the
      // scope the operator reads; it holds the placeholder, and the page
      // states the wait instead of an empty cohort's banner and run cards.
      await waitFor(() => expect(runsTarget()).toHaveTextContent(/^--$/))
      expect(runsTarget()).toHaveAttribute(
        'title',
        'The analysis cohort is still loading.',
      )
      const main = screen.getByRole('main')
      expect(
        within(main).getByText('Loading the cohort...'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('No analysis-cohort subjects'),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText(emptyAnalysisCohortReason([])),
      ).not.toBeInTheDocument()
      expect(screen.queryByText(/\(0 subjects\)/)).not.toBeInTheDocument()

      await act(async () => {
        answer(eligibleCohort(82))
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(runsTarget()).toHaveTextContent(/^All 82 subjects$/),
      )
      expect(runsTarget()).not.toHaveAttribute('title')
      expect(
        within(main).getByRole('button', { name: 'Run all 82' }),
      ).toBeInTheDocument()
      expect(
        within(main).getByText(
          'Runs every stage for the whole analysis cohort (82 subjects).',
        ),
      ).toBeInTheDocument()
    })

    it('states the empty cohort on Runs only once discovery answers with none', async () => {
      const api = createMockApi()
      const answer = deferDiscovery(api)
      await renderWithProject(api)
      openRoute('Runs')
      await waitFor(() => expect(runsTarget()).toHaveTextContent(/^--$/))

      await act(async () => {
        answer([])
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(runsTarget()).toHaveTextContent(/^No analysis-cohort subjects$/),
      )
      expect(
        within(screen.getByRole('main')).getByText(
          emptyAnalysisCohortReason([]),
        ),
      ).toBeInTheDocument()
      expect(
        screen.getByText(
          'Runs every stage for the whole analysis cohort (0 subjects).',
        ),
      ).toBeInTheDocument()
    })

    it('states the run history restore on Runs once discovery counts the cohort', async () => {
      const api = createMockApi()
      const answer = deferDiscovery(api)
      const release = deferRuntimeRestore(api)
      await renderWithProject(api)
      openRoute('Runs')
      await waitFor(() => expect(runsTarget()).toHaveTextContent(/^--$/))
      const main = screen.getByRole('main')
      expect(
        within(main).getByText('Loading the cohort...'),
      ).toBeInTheDocument()

      // On Runs the dock hides its run controls, so the page states the
      // wait: with 82 subjects counted beside "Target", what is pending is
      // the run history restore, not the cohort.
      await act(async () => {
        answer(eligibleCohort(82))
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(runsTarget()).toHaveTextContent(/^All 82 subjects$/),
      )
      expect(
        within(main).getByText('Restoring run history...'),
      ).toBeInTheDocument()
      expect(
        within(main).queryByText('Loading the cohort...'),
      ).not.toBeInTheDocument()
      // The Execution controls stay held until the restore settles.
      expect(
        within(main).queryByRole('button', { name: 'Run all 82' }),
      ).not.toBeInTheDocument()

      await act(async () => {
        release()
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(
          within(main).getByRole('button', { name: 'Run all 82' }),
        ).toBeInTheDocument(),
      )
      expect(
        within(main).queryByText('Restoring run history...'),
      ).not.toBeInTheDocument()
    })

    it('states a counted empty cohort on Runs while the run history restores', async () => {
      const api = createMockApi()
      const answer = deferDiscovery(api)
      deferRuntimeRestore(api)
      await renderWithProject(api)
      openRoute('Runs')
      await waitFor(() => expect(runsTarget()).toHaveTextContent(/^--$/))

      await act(async () => {
        answer([])
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(runsTarget()).toHaveTextContent(/^No analysis-cohort subjects$/),
      )
      // The reason shows at once, as in the dock, not after the restore.
      const main = screen.getByRole('main')
      expect(
        within(main).getByText(emptyAnalysisCohortReason([])),
      ).toBeInTheDocument()
      expect(
        within(main).getByText('Restoring run history...'),
      ).toBeInTheDocument()
      expect(
        within(main).queryByText('Loading the cohort...'),
      ).not.toBeInTheDocument()
    })

    it('holds the Subjects counts as loading, then counts the answered cohort', async () => {
      const api = createMockApi()
      const answer = deferDiscovery(api)
      await renderWithProject(api)
      openRoute('Subjects')

      const main = screen.getByRole('main')
      await waitFor(() =>
        expect(
          within(main).getByText('Discovering subjects...'),
        ).toBeInTheDocument(),
      )
      // No count and no "add subjects" remedy for a cohort still loading.
      expect(within(main).queryByText('-- of --')).toBeNull()
      const filters = within(main).getByRole('radiogroup', {
        name: 'Filter subjects by state',
      })
      expect(
        within(filters).getByRole('radio', { name: 'All' }),
      ).toBeInTheDocument()
      expect(within(filters).queryByText(/\d/)).not.toBeInTheDocument()
      expect(
        within(main).queryByText('Add subjects to this project.'),
      ).not.toBeInTheDocument()

      await act(async () => {
        answer(eligibleCohort(82))
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(
          within(filters).getByRole('radio', { name: 'All 82' }),
        ).toBeInTheDocument(),
      )
      // The header count shows only while a filter narrows the list.
      expect(within(main).queryByText('82 of 82')).toBeNull()
    })

    it('holds the QC review queue and progress as loading, then counts the answered cohort', async () => {
      const api = createMockApi()
      const answer = deferDiscovery(api)
      await renderWithProject(api)
      openRoute('QC review')

      const queue = await screen.findByRole('navigation', {
        name: 'Subject queue',
      })
      expect(within(queue).getByText(/^Queue\s--$/)).toBeInTheDocument()
      expect(
        within(queue).getByText('Loading the cohort...'),
      ).toBeInTheDocument()
      expect(
        within(queue).queryByText('Add subjects to this cohort.'),
      ).not.toBeInTheDocument()
      expect(screen.getByText(/^Cohort progress\s--$/)).toBeInTheDocument()

      await act(async () => {
        answer(eligibleCohort(82))
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(within(queue).getByText(/^Queue\s82$/)).toBeInTheDocument(),
      )
      expect(screen.getByText(/^Cohort progress\s82$/)).toBeInTheDocument()
    })

    it('ends the load when discovery fails while the project opens', async () => {
      const api = createMockApi()
      api.subjects.discover = async () => {
        throw new Error('Retry discovery after the data root is mounted.')
      }
      installLoadableBridge(api)
      render(<App />)
      fireEvent.click(
        screen.getByRole('button', { name: 'Open a saved project' }),
      )
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Open project file...' }),
      )

      // A failed discovery answers with no rows, as a failed refresh does,
      // so the dock does not keep waiting on a load that has ended.
      await waitFor(() =>
        expect(
          dockScopeChip('No analysis-cohort subjects'),
        ).toBeInTheDocument(),
      )
      expect(
        within(screen.getByRole('contentinfo')).queryByText(
          'Loading the cohort...',
        ),
      ).not.toBeInTheDocument()
    })
  })

  it('names the launch in progress beside the dock before the plan review opens', async () => {
    const cohort = makeMockCohort(2, 519).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    let release!: (value: WorkflowResult) => void
    vi.spyOn(api.pipeline, 'planWorkflow').mockImplementationOnce(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          release = resolve
        }),
    )
    await renderWithProject(api)
    const runAll = await screen.findByRole('button', { name: 'Run all 2' })
    await waitFor(() => expect(runAll).toBeEnabled())
    fireEvent.click(runAll)
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    // What Review plan does next is its tooltip, not standing text.
    expect(dialog).not.toHaveTextContent(/If anything would run/)
    expect(
      within(dialog).getByRole('button', { name: 'Review plan' }),
    ).toHaveAttribute(
      'title',
      'If anything would run, the plan opens for review. Dry run is on, so nothing executes.',
    )
    // A dry run needs no Allow live runs, so the notice stays out.
    expect(
      within(dialog).queryByRole('button', { name: 'Allow live runs' }),
    ).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review plan' }))
    expect(
      await screen.findByText('Planning the workflow...'),
    ).toBeInTheDocument()
    await act(async () => {
      release({
        runId: null,
        disposition: 'noop',
        plan: {
          planId: 'run-0123456789ab',
          analysisCohort: { subjectIds: [], sha256: 'a'.repeat(64) },
          selectedSubset: { subjectIds: [], sha256: 'a'.repeat(64) },
          nodes: [],
          blockers: [],
          summary: {
            planned: 0,
            started: 0,
            waiting: 0,
            blocked: 0,
            skipped: 0,
            message: 'Continue because nothing is required.',
          },
          digest: 'b'.repeat(64),
        },
        summary: {
          planned: 0,
          started: 0,
          waiting: 0,
          blocked: 0,
          skipped: 0,
          message: 'Continue because nothing is required.',
        },
      } as WorkflowResult)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        screen.queryByText('Planning the workflow...'),
      ).not.toBeInTheDocument(),
    )
  })

  it('holds the dock while a plan is pending and lets its outcome be dismissed', async () => {
    const cohort = makeMockCohort(2, 527).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const failedRun: RunSnapshot = {
      runId: 'run-failed',
      projectId: LOADED_PROJECT_RESULT.project.projectId,
      projectEpoch: 1,
      status: 'failed',
      startedAt: 1,
      endedAt: 2,
      dryRun: true,
      durable: true,
      acknowledgements: {
        includeDeferredAndUnreviewedQc: false,
        acknowledgeMemoryAdvisory: false,
      },
      summary: {
        planned: 1,
        started: 1,
        waiting: 0,
        blocked: 0,
        skipped: 0,
        message: 'failed',
      },
    }
    // Arm Resume failed, so the plan, not a missing run, is what holds it.
    api.runtime.bootstrap = vi.fn(async ({ project }) => ({
      project,
      sidecarGeneration: 1,
      sequence: 1,
      runs: [{ ...failedRun, projectEpoch: project.epoch }],
      jobs: [],
      logTail: [],
      provision: null,
    }))
    let release!: (value: WorkflowResult) => void
    const plan = vi.spyOn(api.pipeline, 'planWorkflow').mockImplementation(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          release = resolve
        }),
    )
    const resume = vi.spyOn(api.pipeline, 'resumeWorkflow')
    await renderWithProject(api)
    const dock = screen.getByRole('contentinfo')
    await waitFor(() =>
      expect(
        within(dock).getByRole('button', { name: 'Resume failed' }),
      ).toBeEnabled(),
    )

    await launchRunAllFromDock('Run all 2')
    expect(
      await screen.findByText('Planning the workflow...'),
    ).toBeInTheDocument()
    const waitReason = 'Supraspina is planning the workflow.'
    for (const [name, shortcut] of [
      ['Run all 2', ' Shortcut: R.'],
      ['Run step...', ''],
      ['Resume failed', ' Shortcut: Shift+R.'],
    ] as const) {
      const control = within(dock).getByRole('button', { name })
      expect(control).toBeDisabled()
      expect(control).toHaveAttribute('title', `${waitReason}${shortcut}`)
    }

    // Neither the shortcuts nor the palette start a second plan.
    fireEvent.keyDown(window, { key: 'r' })
    fireEvent.keyDown(window, { key: 'R' })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole(
        'option',
        { name: 'Run all' },
      ),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      screen.queryByRole('dialog', {
        name: 'Review the run plan?',
      }),
    ).not.toBeInTheDocument()
    expect(plan).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()

    await act(async () => {
      release(noopResult('No work is scheduled: all 4 jobs are current.'))
      await Promise.resolve()
    })
    expect(
      await screen.findByText('No work is scheduled: all 4 jobs are current.'),
    ).toBeInTheDocument()
    expect(
      within(dock).getByRole('button', { name: 'Run all 2' }),
    ).toBeEnabled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss the workflow outcome' }),
    )
    expect(
      screen.queryByText('No work is scheduled: all 4 jobs are current.'),
    ).not.toBeInTheDocument()
  })

  it('states the resume it waits for while the dock plans a resume', async () => {
    const cohort = makeMockCohort(2, 528).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const failedRun: RunSnapshot = {
      runId: 'run-failed',
      projectId: LOADED_PROJECT_RESULT.project.projectId,
      projectEpoch: 1,
      status: 'failed',
      startedAt: 1,
      endedAt: 2,
      dryRun: true,
      durable: true,
      acknowledgements: {
        includeDeferredAndUnreviewedQc: false,
        acknowledgeMemoryAdvisory: false,
      },
      summary: {
        planned: 1,
        started: 1,
        waiting: 0,
        blocked: 0,
        skipped: 0,
        message: 'failed',
      },
    }
    api.runtime.bootstrap = vi.fn(async ({ project }) => ({
      project,
      sidecarGeneration: 1,
      sequence: 1,
      runs: [{ ...failedRun, projectEpoch: project.epoch }],
      jobs: [],
      logTail: [],
      provision: null,
    }))
    let release!: (value: WorkflowResult) => void
    vi.spyOn(api.pipeline, 'resumeWorkflow').mockImplementation(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          release = resolve
        }),
    )
    await renderWithProject(api)
    const dock = screen.getByRole('contentinfo')
    const resume = within(dock).getByRole('button', { name: 'Resume failed' })
    await waitFor(() => expect(resume).toBeEnabled())
    fireEvent.click(resume)

    expect(await screen.findByText('Planning the resume...')).toBeVisible()
    // The held controls state what Supraspina is doing, not an order to wait.
    for (const [name, shortcut] of [
      ['Run all 2', ' Shortcut: R.'],
      ['Run step...', ''],
      ['Resume failed', ' Shortcut: Shift+R.'],
    ] as const) {
      const control = within(dock).getByRole('button', { name })
      expect(control).toBeDisabled()
      expect(control).toHaveAttribute(
        'title',
        `Supraspina is planning the resume.${shortcut}`,
      )
    }

    await act(async () => {
      release(noopResult('No work is scheduled.'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        within(dock).getByRole('button', { name: 'Run all 2' }),
      ).toBeEnabled(),
    )
  })

  it('shows and holds a plan started from the dock on Runs', async () => {
    const cohort = makeMockCohort(2, 529).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    // Arm Retry canceled, so the plan, not a missing run, is what holds it.
    api.runtime.bootstrap = vi.fn(async ({ project }) => ({
      project,
      sidecarGeneration: 1,
      sequence: 1,
      runs: [
        {
          runId: 'run-cancelled',
          projectId: project.projectId,
          projectEpoch: project.epoch,
          status: 'cancelled' as const,
          startedAt: 1,
          endedAt: 2,
          dryRun: true,
          durable: true,
          acknowledgements: {
            includeDeferredAndUnreviewedQc: false,
            acknowledgeMemoryAdvisory: false,
          },
          summary: {
            planned: 1,
            started: 1,
            waiting: 0,
            blocked: 0,
            skipped: 0,
            message: 'cancelled',
          },
        },
      ],
      jobs: [],
      logTail: [],
      provision: null,
    }))
    let release!: (value: WorkflowResult) => void
    const plan = vi.spyOn(api.pipeline, 'planWorkflow').mockImplementation(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          release = resolve
        }),
    )
    await renderWithProject(api)

    await launchRunAllFromDock('Run all 2')
    expect(
      await screen.findByText('Planning the workflow...'),
    ).toBeInTheDocument()
    openTab('Runs')
    // Runs names the dock's plan once, in its own banner.
    await screen.findByRole('button', { name: 'Run all 2' })
    expect(screen.getAllByText('Planning the workflow...')).toHaveLength(1)
    const waitReason = 'Supraspina is planning the workflow.'
    const held = ['Run all 2', 'Retry canceled...', 'Run Brain FOV preparation']
    for (const name of held) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    expect(screen.getAllByText(waitReason).length).toBeGreaterThanOrEqual(
      held.length,
    )
    fireEvent.keyDown(window, { key: 'r' })
    expect(
      screen.queryByRole('dialog', { name: 'Review the run plan?' }),
    ).not.toBeInTheDocument()
    expect(plan).toHaveBeenCalledTimes(1)

    await act(async () => {
      release(noopResult('No work is scheduled: all 4 jobs are current.'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run all 2' })).toBeEnabled(),
    )
    for (const name of held) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
    expect(screen.queryByText(waitReason)).not.toBeInTheDocument()
    expect(
      screen.queryByText('Planning the workflow...'),
    ).not.toBeInTheDocument()
  })

  it('replaces an earlier Runs outcome with the pending line of a dock plan', async () => {
    const cohort = makeMockCohort(2, 531).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const earlier = 'No work is scheduled: all 288 jobs are current.'
    const later = 'No work is scheduled: all 289 jobs are current.'
    let release!: (value: WorkflowResult) => void
    vi.spyOn(api.pipeline, 'planWorkflow')
      .mockImplementationOnce(async () => noopResult(earlier))
      .mockImplementationOnce(
        () =>
          new Promise<WorkflowResult>((resolve) => {
            release = resolve
          }),
      )
    await renderWithProject(api)

    // An earlier plan started on Runs leaves its outcome there.
    openTab('Runs')
    const runAllCard = await screen.findByRole('button', {
      name: 'Run all 2',
    })
    await waitFor(() => expect(runAllCard).toBeEnabled())
    fireEvent.click(runAllCard)
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Review the run plan?' }),
      ).getByRole('button', { name: 'Review plan' }),
    )
    expect(await screen.findByText(earlier)).toBeInTheDocument()

    openTab('Dashboard')
    await launchRunAllFromDock('Run all 2')
    expect(
      await screen.findByText('Planning the workflow...'),
    ).toBeInTheDocument()
    openTab('Runs')
    await screen.findByRole('button', { name: 'Run all 2' })
    expect(screen.getAllByText('Planning the workflow...')).toHaveLength(1)
    expect(screen.queryByText(earlier)).not.toBeInTheDocument()

    await act(async () => {
      release(noopResult(later))
      await Promise.resolve()
    })
    expect(await screen.findByText(later)).toBeInTheDocument()
    expect(screen.queryByText(earlier)).not.toBeInTheDocument()
    expect(
      screen.queryByText('Planning the workflow...'),
    ).not.toBeInTheDocument()
  })

  it('clears the dock outcome on Runs when a Runs card starts a plan', async () => {
    const cohort = makeMockCohort(2, 532).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const dockOutcome = 'No work is scheduled: all 4 jobs are current.'
    const runsOutcome = 'No work is scheduled: all 5 jobs are current.'
    const releases: Array<(value: WorkflowResult) => void> = []
    vi.spyOn(api.pipeline, 'planWorkflow').mockImplementation(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          releases.push(resolve)
        }),
    )
    await renderWithProject(api)

    // A dock plan that settles while Runs is open leaves its outcome under
    // the dock there.
    await launchRunAllFromDock('Run all 2')
    expect(
      await screen.findByText('Planning the workflow...'),
    ).toBeInTheDocument()
    openTab('Runs')
    const runAllCard = await screen.findByRole('button', {
      name: 'Run all 2',
    })
    await act(async () => {
      releases[0]?.(noopResult(dockOutcome))
      await Promise.resolve()
    })
    expect(await screen.findByText(dockOutcome)).toBeInTheDocument()

    await waitFor(() => expect(runAllCard).toBeEnabled())
    fireEvent.click(runAllCard)
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Review the run plan?' }),
      ).getByRole('button', { name: 'Review plan' }),
    )
    expect(
      (await screen.findAllByText('Planning the workflow...')).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText(dockOutcome)).not.toBeInTheDocument()

    await act(async () => {
      releases[1]?.(noopResult(runsOutcome))
      await Promise.resolve()
    })
    expect(await screen.findByText(runsOutcome)).toBeInTheDocument()
    expect(screen.queryByText(dockOutcome)).not.toBeInTheDocument()
  })

  it('holds the dock, palette, and shortcuts on a plan started on Runs', async () => {
    const cohort = makeMockCohort(2, 530).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    // Arm Resume failed, so the plan, not a missing run, is what holds it.
    api.runtime.bootstrap = vi.fn(async ({ project }) => ({
      project,
      sidecarGeneration: 1,
      sequence: 1,
      runs: [
        {
          runId: 'run-failed',
          projectId: project.projectId,
          projectEpoch: project.epoch,
          status: 'failed' as const,
          startedAt: 1,
          endedAt: 2,
          dryRun: true,
          durable: true,
          acknowledgements: {
            includeDeferredAndUnreviewedQc: false,
            acknowledgeMemoryAdvisory: false,
          },
          summary: {
            planned: 1,
            started: 1,
            waiting: 0,
            blocked: 0,
            skipped: 0,
            message: 'failed',
          },
        },
      ],
      jobs: [],
      logTail: [],
      provision: null,
    }))
    let release!: (value: WorkflowResult) => void
    const plan = vi.spyOn(api.pipeline, 'planWorkflow').mockImplementation(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          release = resolve
        }),
    )
    const resume = vi.spyOn(api.pipeline, 'resumeWorkflow')
    await renderWithProject(api)

    openTab('Runs')
    const stageRun = await screen.findByRole('button', {
      name: 'Run Brain FOV preparation',
    })
    await waitFor(() => expect(stageRun).toBeEnabled())
    fireEvent.click(stageRun)
    fireEvent.click(
      within(
        screen.getByRole('dialog', {
          name: 'Confirm the Brain FOV preparation launch',
        }),
      ).getByRole('button', { name: 'Review plan' }),
    )
    const label = 'Planning Brain FOV preparation...'
    // The banner and the stage card that started the plan both name it.
    expect(await screen.findAllByText(label)).toHaveLength(2)

    openTab('Dashboard')
    const dock = await screen.findByRole('contentinfo')
    const waitReason = 'Supraspina is planning Brain FOV preparation.'
    for (const [name, shortcut] of [
      ['Run all 2', ' Shortcut: R.'],
      ['Run step...', ''],
      ['Resume failed', ' Shortcut: Shift+R.'],
    ] as const) {
      const control = within(dock).getByRole('button', { name })
      expect(control).toBeDisabled()
      expect(control).toHaveAttribute('title', `${waitReason}${shortcut}`)
    }
    expect(screen.getAllByText(label)).toHaveLength(1)

    // Neither the shortcuts nor the palette start a second plan.
    fireEvent.keyDown(window, { key: 'r' })
    fireEvent.keyDown(window, { key: 'R' })
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Command palette' })).getByRole(
        'option',
        { name: 'Run all' },
      ),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(
      screen.queryByRole('dialog', {
        name: 'Review the run plan?',
      }),
    ).not.toBeInTheDocument()
    expect(plan).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()

    await act(async () => {
      release(noopResult('No work is scheduled: all 4 jobs are current.'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        within(dock).getByRole('button', { name: 'Run all 2' }),
      ).toBeEnabled(),
    )
    for (const name of ['Run step...', 'Resume failed']) {
      expect(within(dock).getByRole('button', { name })).toBeEnabled()
    }
    expect(screen.queryByText(label)).not.toBeInTheDocument()
  })

  it('clears a neutral outcome on a tab change and keeps a blocked one', async () => {
    const cohort = makeMockCohort(1, 528).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const originalPlan = api.pipeline.planWorkflow
    vi.spyOn(api.pipeline, 'planWorkflow')
      .mockImplementationOnce(async () =>
        noopResult('No work is scheduled: all 4 jobs are current.'),
      )
      .mockImplementationOnce(async (request) => {
        const planned = await originalPlan(request)
        return {
          ...planned,
          disposition: 'blocked' as const,
          plan: {
            ...planned.plan,
            nodes: [],
            blockers: [
              {
                key: 'clinical' as const,
                kind: 'cohort' as const,
                reason: 'Prepare Clinical merge. Assign registry roles.',
                action: 'open-registry',
                subjects: ['sub-001'],
                subjectCount: 1,
              },
            ],
          },
          summary: {
            ...planned.summary,
            message: 'Clinical merge is blocked for 1 subject.',
          },
        }
      })
    await renderWithProject(api)

    await launchRunAllFromDock('Run all 1')
    expect(
      await screen.findByText('No work is scheduled: all 4 jobs are current.'),
    ).toBeInTheDocument()
    openTab('Subjects')
    await waitFor(() =>
      expect(
        screen.queryByText('No work is scheduled: all 4 jobs are current.'),
      ).not.toBeInTheDocument(),
    )

    await launchRunAllFromDock('Run all 1')
    expect(
      await screen.findByText('Clinical merge is blocked for 1 subject.'),
    ).toBeInTheDocument()
    openTab('Logs')
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Primary' })).getByRole(
          'button',
          { name: 'Logs' },
        ),
      ).toHaveAttribute('aria-current', 'page'),
    )
    expect(
      screen.getByText('Clinical merge is blocked for 1 subject.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'View blockers' }),
    ).toBeInTheDocument()
  })

  it('clears a Runs outcome that found no work on leaving Runs and keeps a blocked one', async () => {
    const cohort = makeMockCohort(1, 534).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const noWork = 'No work is scheduled: all 4 jobs are current.'
    const blocked = 'Clinical merge is blocked for 1 subject.'
    const originalPlan = api.pipeline.planWorkflow
    vi.spyOn(api.pipeline, 'planWorkflow')
      .mockImplementationOnce(async () => noopResult(noWork))
      .mockImplementationOnce(async (request) => {
        const planned = await originalPlan(request)
        return {
          ...planned,
          disposition: 'blocked' as const,
          plan: {
            ...planned.plan,
            nodes: [],
            blockers: [
              {
                key: 'clinical' as const,
                kind: 'cohort' as const,
                reason: 'Prepare Clinical merge.',
              },
            ],
          },
          summary: { ...planned.summary, message: blocked },
        }
      })
    await renderWithProject(api)
    const launchFromRuns = async (): Promise<void> => {
      openTab('Runs')
      const runAllCard = await screen.findByRole('button', {
        name: 'Run all 1',
      })
      await waitFor(() => expect(runAllCard).toBeEnabled())
      fireEvent.click(runAllCard)
      fireEvent.click(
        within(
          screen.getByRole('dialog', { name: 'Review the run plan?' }),
        ).getByRole('button', { name: 'Review plan' }),
      )
    }

    await launchFromRuns()
    expect(await screen.findByText(noWork)).toBeInTheDocument()
    openTab('Subjects')
    openTab('Runs')
    await screen.findByRole('button', { name: 'Run all 1' })
    expect(screen.queryByText(noWork)).not.toBeInTheDocument()

    await launchFromRuns()
    expect(await screen.findByText(blocked)).toBeInTheDocument()
    openTab('Subjects')
    openTab('Runs')
    await screen.findByRole('button', { name: 'Run all 1' })
    expect(screen.getByText(blocked)).toBeInTheDocument()
    // A blocked outcome stays until the operator dismisses it.
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss the workflow outcome' }),
    )
    expect(screen.queryByText(blocked)).not.toBeInTheDocument()
  })

  it('requires QC and memory acknowledgments and forwards the exact run scope', async () => {
    const cohort = makeMockCohort(2, 518).map((subject, index) => ({
      ...subject,
      qc: index === 0 ? ('defer' as const) : null,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const baseline = await api.env.check({
      project: LOADED_PROJECT_RESULT.project,
      cfg: LOADED_PROJECT,
      configRevision: 0,
    })
    const lowMemory: EnvReport = { ...baseline, availableMemoryGB: 1.5 }
    api.env.check = vi.fn(async () => lowMemory)
    const planWorkflow = vi.spyOn(api.pipeline, 'planWorkflow')
    const runWorkflow = vi.spyOn(api.pipeline, 'runWorkflow')

    await renderWithProject(api)
    await waitFor(() => expect(api.env.check).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    const runAll = await screen.findByRole('button', { name: 'Run all 2' })
    await waitFor(() => expect(runAll).toBeEnabled())
    fireEvent.click(runAll)

    let dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    const qcAck = within(dialog).getByRole('checkbox', {
      name: 'Include Defer and unreviewed subjects (QC Fail subjects stay excluded)',
    })
    const memoryAck = within(dialog).getByRole('checkbox', {
      name: /^Continue although available host memory \(1\.5 GB\) is below this project's \d+ GB memory advisory threshold\.$/,
    })
    const confirm = within(dialog).getByRole('button', {
      name: 'Review plan',
    })
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveAttribute('title', 'Check the box above to continue.')
    // The dock explains its disabled Review plan as the Runs dialogs do,
    // naming the rows by verdict.
    expect(dialog).toHaveTextContent(
      '1 Defer and 1 unreviewed subjects are in the analysis cohort. Check the box to continue.',
    )
    expect(dialog).toHaveTextContent(
      /Review plan needs this acknowledgement while available host memory is below \d+ GB\./,
    )
    fireEvent.click(qcAck)
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveAttribute('title', 'Check the box above to continue.')
    fireEvent.click(memoryAck)
    expect(confirm).toBeEnabled()
    // Once enabled, the tooltip says what Review plan does next.
    expect(confirm).toHaveAttribute(
      'title',
      expect.stringMatching(/^If anything would run, the plan opens/),
    )
    fireEvent.click(confirm)

    const planReview = await screen.findByRole('dialog', {
      name: 'Review the exact workflow plan.',
    })
    expect(planReview).toHaveTextContent('Resources and environment')
    expect(planReview).toHaveTextContent('Selected execution subset: 2')
    fireEvent.click(
      within(planReview).getByRole('button', { name: 'Accept plan' }),
    )

    await waitFor(() => expect(planWorkflow).toHaveBeenCalledOnce())
    expect(planWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: { kind: 'workflow', target: { mode: 'all' } },
        acknowledgements: {
          includeDeferredAndUnreviewedQc: true,
          acknowledgeMemoryAdvisory: true,
        },
      }),
    )
    expect(runWorkflow).toHaveBeenCalledOnce()
    expect(runWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedPlan: expect.objectContaining({
          planId: expect.stringMatching(/^run-[a-f0-9]{12}$/),
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    )
    expect(runWorkflow.mock.calls[0]?.[0]).not.toHaveProperty(
      'liveExecutionAuthorization',
    )
    // The Dashboard's cohort notice is a status too.
    expect(
      (
        await screen.findByText(
          /Dry run only: planned \d+ commands? and executed nothing\./,
        )
      ).closest('[role="status"]'),
    ).not.toBeNull()

    planWorkflow.mockRejectedValueOnce(
      'Retry because the workflow service refused the request.',
    )
    fireEvent.click(runAll)
    dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: /Include Defer and unreviewed subjects/,
      }),
    )
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: /Continue although available host memory/,
      }),
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review plan' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Retry starting the workflow.',
    )
  })

  it('shows a live dock plan read-only while Allow live runs is off and starts nothing', async () => {
    const cohort = makeMockCohort(1, 811).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const planWorkflow = vi.spyOn(api.pipeline, 'planWorkflow')
    const runWorkflow = vi.spyOn(api.pipeline, 'runWorkflow')
    const authorize = vi.spyOn(api.execution, 'authorize')

    await renderWithProject(api, {
      ...LOADED_PROJECT,
      runtime: { ...LOADED_PROJECT.runtime, dryRun: false },
    })
    const runAll = await screen.findByRole('button', { name: 'Run all 1' })
    await waitFor(() => expect(runAll).toBeEnabled())
    fireEvent.click(runAll)
    const confirm = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    expect(
      within(confirm).getByRole('button', { name: 'Review plan' }),
    ).toHaveAttribute(
      'title',
      'If anything would run, the plan opens read-only, because Allow live runs is off.',
    )
    // The dock confirmation carries the same Allow live runs notice as the
    // Runs one, and states the scope by the enabled stages' names.
    expect(confirm).toHaveTextContent(
      'Allow live runs is off for this session. Turn it on, then save the project to authorize and run live.',
    )
    expect(
      within(confirm).getByRole('button', { name: 'Allow live runs' }),
    ).toBeEnabled()
    // The scope is the one standing sentence.
    expect(
      within(confirm).getByText(
        'Brain FOV preparation and Reconstruction run for the 1 subject in the analysis cohort; cohort-wide stages run once after them.',
      ).tagName,
    ).toBe('P')
    expect(confirm).not.toHaveTextContent(/Deface|defacing|Recon nodes/)
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Review plan' }),
    )

    const review = await screen.findByRole('dialog', {
      name: 'Review the exact workflow plan.',
    })
    expect(review).toHaveTextContent(
      /shown read-only because Allow live runs is off\. Nothing starts from this review\./,
    )
    expect(
      within(review).getByRole('button', { name: 'Authorize this plan' }),
    ).toBeDisabled()
    expect(review).toHaveTextContent(
      'Authorize this plan is unavailable because Allow live runs is off.',
    )
    // Once the plan is shown, the planning line is no longer true, so it
    // leaves the page behind the review; the modal holds every other launch
    // meanwhile. Nothing claims that anything starts.
    expect(screen.queryByText('Planning the workflow...')).toBeNull()
    expect(
      screen.queryByText('Planning and starting the workflow...'),
    ).toBeNull()

    fireEvent.click(within(review).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(screen.queryByText('Planning the workflow...')).toBeNull(),
    )
    expect(screen.getByRole('button', { name: 'Run all 1' })).toBeEnabled()
    expect(planWorkflow).toHaveBeenCalledOnce()
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    expect(screen.queryByText(/to start live work/)).toBeNull()
  })

  it('keeps digit route shortcuts from navigating behind an open dialog', async () => {
    const cohort = makeMockCohort(1, 733).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    await renderWithProject(cohortApi(cohort))
    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Subjects' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Review the run plan?',
    })

    // 5 maps to Registry; the background must not move behind the dialog.
    fireEvent.keyDown(window, { key: '5' })
    expect(dialog).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(
      within(rail).getByRole('button', { name: 'Subjects' }),
    ).toHaveAttribute('aria-current', 'page')
    expect(
      within(rail).getByRole('button', { name: 'Registry' }),
    ).not.toHaveAttribute('aria-current')
  })

  it('clears the planning line while the plan is shown and holds launches from approval to the start', async () => {
    const cohort = makeMockCohort(1, 741).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const originalRun = api.pipeline.runWorkflow
    let startRun: (() => void) | null = null
    const run = vi
      .spyOn(api.pipeline, 'runWorkflow')
      .mockImplementation(async (request) => {
        if (request.approvedPlan) {
          await new Promise<void>((resolve) => {
            startRun = resolve
          })
        }
        return originalRun(request)
      })

    await renderWithProject(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Review the run plan?' }),
      ).getByRole('button', { name: 'Review plan' }),
    )
    const review = await screen.findByRole('dialog', {
      name: 'Review the exact workflow plan.',
    })
    // The plan is on screen, so the page no longer says it is being planned.
    expect(screen.queryByText('Planning the workflow...')).toBeNull()

    fireEvent.click(within(review).getByRole('button', { name: 'Accept plan' }))
    // From approval until the run starts, the launch holds every control
    // again, so a second launch cannot slip in after the review closes.
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Planning the workflow...')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Run all 1' })).toBeDisabled()

    await act(async () => {
      startRun?.()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.queryByText('Planning the workflow...')).toBeNull(),
    )
  })

  it('holds a Logs retry while a dock launch plans and keeps the dock line', async () => {
    const cohort = makeMockCohort(1, 741).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const subjectId = cohort[0]!.id
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    // A failed run gives Logs a node to retry.
    const originalBootstrap = api.runtime.bootstrap
    vi.spyOn(api.runtime, 'bootstrap').mockImplementation(async (request) => {
      const snapshot = await originalBootstrap(request)
      const failedJob: Job = {
        id: 'job-f1',
        runId: 'run-0000000000f1',
        nodeId: 'node-f1',
        projectId: snapshot.project.projectId,
        projectEpoch: snapshot.project.epoch,
        sidecarGeneration: snapshot.sidecarGeneration,
        stepKey: 'recon',
        subjectId,
        startedAt: 100,
        endedAt: 200,
        exitCode: 1,
        cmd: 'recon-all',
        stdoutPath: '',
        stderrPath: '',
        envSnapshotPath: '',
        configSnapshotPath: '',
        status: 'failed',
        durable: true,
      }
      const failedRun: RunSnapshot = {
        runId: 'run-0000000000f1',
        projectId: snapshot.project.projectId,
        projectEpoch: snapshot.project.epoch,
        status: 'failed',
        startedAt: 100,
        endedAt: 200,
        dryRun: false,
        durable: true,
        acknowledgements: {
          includeDeferredAndUnreviewedQc: false,
          acknowledgeMemoryAdvisory: false,
        },
        summary: {
          planned: 1,
          started: 1,
          waiting: 0,
          blocked: 0,
          skipped: 0,
          message: 'failed',
        },
      }
      return {
        ...snapshot,
        runs: [...snapshot.runs, failedRun],
        jobs: [...snapshot.jobs, failedJob],
      }
    })
    // The dock's plan does not answer until the test releases it.
    let answerDockPlan: (() => void) | null = null
    const originalPlan = api.pipeline.planWorkflow
    const planWorkflow = vi
      .spyOn(api.pipeline, 'planWorkflow')
      .mockImplementation(async (request) => {
        await new Promise<void>((resolve) => {
          answerDockPlan = resolve
        })
        return originalPlan(request)
      })
    const summary = {
      planned: 1,
      started: 0,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: 'This pass runs 1 node.',
    }
    const retryWorkflow = vi
      .spyOn(api.pipeline, 'retryWorkflow')
      .mockImplementation(
        async () =>
          ({
            runId: null,
            disposition: 'planned',
            plan: {
              planId: 'run-abcdef123456',
              digest: 'a'.repeat(64),
              configDigest: 'b'.repeat(64),
              qcDigest: 'c'.repeat(64),
              registryDigest: 'd'.repeat(64),
              environmentDigest: 'e'.repeat(64),
              analysisCohort: { subjectIds: [], sha256: 'analysis' },
              selectedSubset: { subjectIds: [], sha256: 'selected' },
              nodes: [
                {
                  nodeId: 'node-f1',
                  stepKey: 'recon',
                  scope: 'subject',
                  subjectId,
                  status: 'planned',
                  dependencies: [],
                  command: 'recon-all',
                },
              ],
              blockers: [],
              resources: {
                queueSize: 2,
                availableMemoryGB: 16,
                memoryWarningGB: 10,
                lowMemory: false,
              },
              summary,
            },
            summary,
          }) as WorkflowResult,
      )

    await renderWithProject(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Review the run plan?' }),
      ).getByRole('button', { name: 'Review plan' }),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run all 1' })).toBeDisabled(),
    )
    expect(screen.getByText('Planning the workflow...')).toBeVisible()

    // The Logs retry shares the planning line every launch does, so it
    // waits for the dock's plan and names it; the dock's line stays.
    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Logs' }))
    const retry = await screen.findByRole('button', {
      name: 'Retry job',
    })
    expect(retry).toBeDisabled()
    expect(retry).toHaveAttribute(
      'title',
      'Supraspina is planning the workflow.',
    )
    fireEvent.click(retry)
    expect(retryWorkflow).not.toHaveBeenCalled()

    // The dock still holds every launch, so no second plan starts beside
    // the unanswered one.
    expect(screen.getByText('Planning the workflow...')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Run all 1' })).toBeDisabled()
    expect(planWorkflow).toHaveBeenCalledOnce()

    // The dock's own plan then opens for review and releases its line.
    await act(async () => {
      answerDockPlan?.()
      await Promise.resolve()
    })
    const dockReview = await screen.findByRole('dialog', {
      name: 'Review the exact workflow plan.',
    })
    expect(screen.queryByText('Planning the workflow...')).toBeNull()
    fireEvent.click(within(dockReview).getByRole('button', { name: 'Cancel' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run all 1' })).toBeEnabled(),
    )
    expect(planWorkflow).toHaveBeenCalledOnce()
    // Once the dock's plan settles, the retry is free again.
    expect(screen.getByRole('button', { name: 'Retry job' })).toBeEnabled()
  })

  it('offers Review again for a stale global run and starts from a fresh plan', async () => {
    const cohort = makeMockCohort(1, 721).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const plan = vi.spyOn(api.pipeline, 'planWorkflow')
    const originalRun = api.pipeline.runWorkflow
    let rejectFinalOnce = true
    const run = vi
      .spyOn(api.pipeline, 'runWorkflow')
      .mockImplementation(async (request) => {
        if (request.approvedPlan && rejectFinalOnce) {
          rejectFinalOnce = false
          // Compare the message because context isolation reconstructs the error.
          throw new Error(PLAN_STALE_MESSAGE)
        }
        return originalRun(request)
      })

    await renderWithProject(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    fireEvent.click(
      within(
        screen.getByRole('dialog', {
          name: 'Review the run plan?',
        }),
      ).getByRole('button', { name: 'Review plan' }),
    )
    fireEvent.click(
      within(
        await screen.findByRole('dialog', {
          name: 'Review the exact workflow plan.',
        }),
      ).getByRole('button', { name: 'Accept plan' }),
    )

    const reviewAgain = await screen.findByRole('button', {
      name: 'Review again',
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Review the workflow plan again because the approved plan changed.',
    )
    expect(plan).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)

    fireEvent.click(reviewAgain)
    fireEvent.click(
      within(
        await screen.findByRole('dialog', {
          name: 'Review the exact workflow plan.',
        }),
      ).getByRole('button', { name: 'Accept plan' }),
    )

    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(plan.mock.calls[1]?.[0].intent).toEqual({
      kind: 'workflow',
      target: { mode: 'all' },
    })
  })

  it('keeps every blocked subject reachable from the global run notice', async () => {
    const cohort = makeMockCohort(1, 726).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const blockedSubjectIds = Array.from(
      { length: 11 },
      (_value, index) => `sub-${String(index + 1).padStart(3, '0')}`,
    )
    const originalPlan = api.pipeline.planWorkflow
    api.pipeline.planWorkflow = async (request) => {
      const planned = await originalPlan(request)
      return {
        ...planned,
        disposition: 'blocked' as const,
        plan: {
          ...planned.plan,
          nodes: [],
          blockers: [
            {
              key: 'clinical' as const,
              kind: 'cohort' as const,
              reason: `Prepare Clinical merge. Assign registry roles to ${blockedSubjectIds
                .slice(0, 8)
                .join(', ')} (+3 more).`,
              action: 'open-registry',
              subjects: blockedSubjectIds,
              subjectCount: blockedSubjectIds.length,
            },
          ],
        },
      }
    }

    await renderWithProject(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    fireEvent.click(
      within(
        screen.getByRole('dialog', {
          name: 'Review the run plan?',
        }),
      ).getByRole('button', { name: 'Review plan' }),
    )

    const viewBlockers = await screen.findByRole('button', {
      name: 'View blockers',
    })
    fireEvent.click(viewBlockers)
    const detail = await screen.findByRole('dialog', {
      name: 'Review the blockers of this result.',
    })
    expect(detail).toHaveTextContent('Prepare Clinical merge.')
    expect(within(detail).getByText('sub-011')).not.toBeVisible()

    fireEvent.click(within(detail).getByText('Show all 11 subjects'))
    const subjects = within(detail).getByRole('list', {
      name: 'Subjects blocked in Clinical merge',
    })
    for (const subjectId of blockedSubjectIds) {
      expect(within(subjects).getByText(subjectId)).toBeVisible()
    }

    fireEvent.click(
      within(detail).getByRole('button', { name: 'Open Registry' }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    )
    expect(
      within(screen.getByRole('navigation', { name: 'Primary' })).getByRole(
        'button',
        { name: 'Registry' },
      ),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('offers Review again for a stale global resume and re-previews the same run', async () => {
    const cohort = makeMockCohort(1, 722).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const failedRun: RunSnapshot = {
      runId: 'run-failed',
      projectId: LOADED_PROJECT_RESULT.project.projectId,
      projectEpoch: 1,
      status: 'failed',
      startedAt: 1,
      endedAt: 2,
      dryRun: true,
      durable: true,
      acknowledgements: {
        includeDeferredAndUnreviewedQc: false,
        acknowledgeMemoryAdvisory: false,
      },
      summary: {
        planned: 1,
        started: 1,
        waiting: 0,
        blocked: 0,
        skipped: 0,
        message: 'failed',
      },
    }
    api.runtime.bootstrap = vi.fn(async ({ project }) => ({
      project,
      sidecarGeneration: 1,
      sequence: 1,
      runs: [{ ...failedRun, projectEpoch: project.epoch }],
      jobs: [],
      logTail: [],
      provision: null,
    }))
    const originalResume = api.pipeline.resumeWorkflow
    let rejectFinalOnce = true
    const resume = vi
      .spyOn(api.pipeline, 'resumeWorkflow')
      .mockImplementation(async (request) => {
        if (request.previewOnly) {
          return api.pipeline.planWorkflow({
            project: request.project,
            cfg: request.cfg,
            configRevision: request.configRevision,
            intent: { kind: 'workflow', target: { mode: 'all' } },
            acknowledgements: request.acknowledgements,
          })
        }
        if (request.approvedPlan && rejectFinalOnce) {
          rejectFinalOnce = false
          // Compare the message because context isolation reconstructs the error.
          throw new Error(PLAN_STALE_MESSAGE)
        }
        return originalResume(request)
      })

    await renderWithProject(api)
    const resumeButton = await screen.findByRole('button', {
      name: 'Resume failed',
    })
    await waitFor(() => expect(resumeButton).toBeEnabled())
    fireEvent.click(resumeButton)
    fireEvent.click(
      within(
        await screen.findByRole('dialog', {
          name: 'Review the exact resume plan.',
        }),
      ).getByRole('button', { name: 'Accept plan' }),
    )

    const reviewAgain = await screen.findByRole('button', {
      name: 'Review again',
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Review the workflow plan again because the approved plan changed.',
    )

    fireEvent.click(reviewAgain)
    fireEvent.click(
      within(
        await screen.findByRole('dialog', {
          name: 'Review the exact resume plan.',
        }),
      ).getByRole('button', { name: 'Accept plan' }),
    )

    await waitFor(() =>
      expect(
        resume.mock.calls.filter(([request]) => request.previewOnly === true),
      ).toHaveLength(2),
    )
    await waitFor(() =>
      expect(
        resume.mock.calls.filter(([request]) => request.approvedPlan),
      ).toHaveLength(2),
    )
    for (const [request] of resume.mock.calls) {
      expect(request.runId).toBe('run-failed')
    }
  })

  it('offers Run whole cohort on Runs only beside an explicit selection', async () => {
    const cohort = makeMockCohort(2, 303).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    await renderWithProject(cohortApi(cohort))

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Runs' }))
    await screen.findByRole('button', { name: 'Run all 2' })
    expect(screen.queryByText('Run whole cohort')).toBeNull()

    fireEvent.click(within(rail).getByRole('button', { name: 'Subjects' }))
    fireEvent.click(
      await screen.findByRole('checkbox', { name: `Select ${cohort[0]!.id}` }),
    )
    fireEvent.click(within(rail).getByRole('button', { name: 'Runs' }))
    expect(await screen.findByText('Run whole cohort')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Run cohort...' }),
    ).toBeInTheDocument()
  })

  it('keeps explicit-empty scope distinct and restores whole-cohort scope on request', async () => {
    const cohort = makeMockCohort(1, 302).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    const api = cohortApi(cohort)
    const host = await packagedHost(api, {
      sidecar: { projectAttached: true },
    })
    api.host.getState = async () => host
    const planWorkflow = vi.spyOn(api.pipeline, 'planWorkflow')
    await renderWithProject(api)

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    fireEvent.click(within(rail).getByRole('button', { name: 'Subjects' }))
    const subject = await screen.findByRole('checkbox', {
      name: `Select ${cohort[0]!.id}`,
    })
    fireEvent.click(subject)
    const clear = screen.getByRole('button', {
      name: 'Clear selected subjects',
    })
    expect(clear).toHaveStyle({ width: '24px' })
    fireEvent.click(clear)

    expect(screen.getByText('No subjects selected')).toBeInTheDocument()
    const runSelection = screen.getByRole('button', { name: 'Run selection' })
    fireEvent.click(runSelection)
    await waitFor(() => expect(planWorkflow).toHaveBeenCalledOnce())
    expect(planWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          kind: 'workflow',
          target: { mode: 'explicit', subjectIds: [] },
        },
      }),
    )
    expect(
      screen.queryByRole('dialog', {
        name: 'Review the run plan?',
      }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Use the full analysis cohort' }),
    )
    expect(screen.getByText('All 1 subject')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run all 1' })).toBeEnabled()
  })

  it('returns to the Setup wizard and re-gates the shell on New', async () => {
    const api = createMockApi()
    const bootstrap = vi.spyOn(api.runtime, 'bootstrap')
    await renderWithProject(api)
    await waitFor(() => expect(bootstrap).toHaveBeenCalled())
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    })
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'New' }))

    await waitFor(() =>
      expect(
        screen.queryByRole('navigation', { name: 'Primary' }),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('heading', { name: 'Set up your project' }),
    ).toBeInTheDocument()
  })

  it('lands a loaded project on Review and preserves the Setup step across leaving and returning', async () => {
    await renderWithProject()
    const rail = screen.getByRole('navigation', { name: 'Primary' })

    fireEvent.click(within(rail).getByRole('button', { name: 'Setup' }))
    expect(screen.getByText('Step 5 of 5')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Step 2:/ }))
    expect(screen.getByText('Step 2 of 5')).toBeTruthy()

    fireEvent.click(within(rail).getByRole('button', { name: 'Dashboard' }))
    fireEvent.click(within(rail).getByRole('button', { name: 'Setup' }))

    expect(screen.getByText('Step 2 of 5')).toBeTruthy()
  })

  it('opens the first-run preferences dialog on a blank profile', () => {
    localStorage.removeItem('supraspinaFirstRunDone')
    render(<App />)
    expect(
      screen.getByRole('dialog', { name: 'Welcome to Supraspina' }),
    ).toBeInTheDocument()
  })

  it('reopens the most recent project when the packaged app starts empty', async () => {
    localStorage.setItem(
      'supraspinaRecentProjects',
      JSON.stringify([
        {
          name: 'Loaded study',
          path: '/data/projects/demo/supraspina.project.json',
          openedAt: '2026-09-18T00:00:00.000Z',
        },
      ]),
    )
    const api = createMockApi()
    const host = await packagedHost(api, {
      mode: 'electron',
      platform: 'linux',
      captionMode: 'custom',
    })
    api.host.getState = async () => host
    const bridged = installLoadableBridge(api)
    const openSpy = vi.fn(bridged.project.open)
    bridged.project.open =
      openSpy as unknown as SupraspinaApi['project']['open']
    render(<App />)
    await waitFor(() =>
      expect(
        screen.getByLabelText('Current project: Loaded study'),
      ).toBeInTheDocument(),
    )
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(openSpy.mock.calls[0]?.[0].path).toBe(
      '/data/projects/demo/supraspina.project.json',
    )
  })

  it('keeps the setup wizard when the recent project no longer opens', async () => {
    localStorage.setItem(
      'supraspinaRecentProjects',
      JSON.stringify([
        {
          name: 'Moved study',
          path: '/data/projects/moved/supraspina.project.json',
          openedAt: '2026-09-18T00:00:00.000Z',
        },
      ]),
    )
    const api = createMockApi()
    const host = await packagedHost(api, {
      mode: 'electron',
      platform: 'linux',
      captionMode: 'custom',
    })
    api.host.getState = async () => host
    api.project.open = async () => {
      throw new Error('Provide a project file that exists.')
    }
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)
    expect(await screen.findByText('Set up your project')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Current project: Untitled project'),
    ).toBeInTheDocument()
  })

  it('keeps the first-run dialog closed after completion', () => {
    render(<App />)
    expect(
      screen.queryByRole('dialog', { name: 'Welcome to Supraspina' }),
    ).not.toBeInTheDocument()
  })

  it('opens the command palette on Cmd/Ctrl+K', () => {
    render(<App />)
    expect(
      screen.queryByRole('dialog', { name: 'Command palette' }),
    ).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(
      screen.getByRole('dialog', { name: 'Command palette' }),
    ).toBeInTheDocument()
  })

  it('offers only Setup and Diagnostics in the palette before project load', () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    expect(
      within(dialog).getByRole('option', { name: 'Go to Setup' }),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('option', { name: 'Go to Diagnostics' }),
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('option', { name: 'Go to Dashboard' }),
    ).not.toBeInTheDocument()
    expect(
      within(dialog).queryByRole('option', { name: 'Run all' }),
    ).not.toBeInTheDocument()
  })

  it('reaches the project-free Diagnostics screen from the keymap before project load', async () => {
    render(<App />)
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: '7' })

    expect(await screen.findByText(/No project is open/)).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Diagnostics' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Setup' }))
    expect(
      screen.getByRole('heading', { name: 'Set up your project' }),
    ).toBeInTheDocument()
  })

  it('filters palette options as the query changes', async () => {
    await renderWithProject()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    expect(
      within(dialog).getByRole('option', { name: 'Go to Dashboard' }),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('option', { name: 'Go to Logs' }),
    ).toBeInTheDocument()

    const input = within(dialog).getByRole('combobox')
    fireEvent.change(input, { target: { value: 'Logs' } })

    expect(
      within(dialog).getByRole('option', { name: 'Go to Logs' }),
    ).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('option', { name: 'Go to Dashboard' }),
    ).not.toBeInTheDocument()
  })

  it('announces empty palette results and opens a hovered subject result', async () => {
    const cohort = makeMockCohort(2, 613).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    await renderWithProject(cohortApi(cohort))
    fireEvent.keyDown(window, { key: '/', code: 'Slash' })

    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    const input = within(dialog).getByRole('combobox')
    fireEvent.change(input, { target: { value: 'definitely-no-match' } })
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      'No results match this query.',
    )
    expect(
      within(dialog).getAllByText('No results match this query.'),
    ).toHaveLength(2)
    expect(input).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(dialog).toBeInTheDocument()

    fireEvent.change(input, { target: { value: cohort[1]!.id } })
    const subject = within(dialog).getByRole('option', {
      name: `Open ${cohort[1]!.id}`,
    })
    fireEvent.mouseEnter(subject)
    expect(subject).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(subject)

    const rail = screen.getByRole('navigation', { name: 'Primary' })
    expect(
      within(rail).getByRole('button', { name: 'QC review' }),
    ).toHaveAttribute('aria-current', 'page')
    expect(
      screen.getByRole('heading', {
        name: `Subject ${cohort[1]!.id.replace(/^sub-/, '')}`,
      }),
    ).toBeInTheDocument()
  })

  it('searches every subject in the palette and bounds only the rendered matches', async () => {
    // Number 48 controls from 101 and 34 SCI subjects from 302, so the
    // last subject sits past the bound.
    const cohort = makeMockCohort(82, 613).map((subject, index) => ({
      ...subject,
      id: `sub-${index < 48 ? 101 + index : 302 + index - 48}`,
      qc: 'pass' as const,
      analysisEligible: true,
      unavailableReason: null,
    }))
    await renderWithProject(cohortApi(cohort))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })

    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    const input = within(dialog).getByRole('combobox')
    const subjectOptions = (): HTMLElement[] =>
      within(
        within(dialog).getByRole('group', { name: 'Subjects' }),
      ).getAllByRole('option')

    fireEvent.change(input, { target: { value: 'sub' } })
    expect(subjectOptions()).toHaveLength(PALETTE_SUBJECT_LIMIT)
    const note = `Showing ${PALETTE_SUBJECT_LIMIT} of 82 matching subjects. Type more of the ID.`
    expect(within(dialog).getByText(note)).toBeInTheDocument()
    // "Go to Subjects" also matches, so the status counts 83 results.
    expect(within(dialog).getByRole('status')).toHaveTextContent(
      `83 results. ${note}`,
    )

    fireEvent.change(input, { target: { value: 'sub-333' } })
    expect(subjectOptions()).toHaveLength(1)
    expect(within(dialog).queryByText(note)).not.toBeInTheDocument()
    expect(within(dialog).getByRole('status')).toHaveTextContent('1 result.')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(
      screen.queryByRole('dialog', { name: 'Command palette' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Subject 333' }),
    ).toBeInTheDocument()
  })

  it('switches routes when Enter activates a navigation option', async () => {
    await renderWithProject()
    const rail = screen.getByRole('navigation', { name: 'Primary' })
    expect(
      within(rail).getByRole('button', { name: 'Logs' }),
    ).not.toHaveAttribute('aria-current', 'page')

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    const input = within(dialog).getByRole('combobox')
    fireEvent.change(input, { target: { value: 'Logs' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(
      screen.queryByRole('dialog', { name: 'Command palette' }),
    ).not.toBeInTheDocument()
    expect(within(rail).getByRole('button', { name: 'Logs' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('switches routes when a navigation option is clicked', async () => {
    await renderWithProject()
    const rail = screen.getByRole('navigation', { name: 'Primary' })

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    fireEvent.click(
      within(dialog).getByRole('option', { name: 'Go to Registry' }),
    )

    expect(
      screen.queryByRole('dialog', { name: 'Command palette' }),
    ).not.toBeInTheDocument()
    expect(
      within(rail).getByRole('button', { name: 'Registry' }),
    ).toHaveAttribute('aria-current', 'page')
  })

  it('closes the command palette on Escape', async () => {
    render(<App />)
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(
      screen.getByRole('dialog', { name: 'Command palette' }),
    ).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Command palette' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('suppresses global r, R, and c verbs behind every open dialog', async () => {
    const api = createMockApi()
    const mockOpen = api.project.open
    api.project.open = async (request) => {
      await mockOpen(request)
      return {
        ...LOADED_PROJECT_RESULT,
        project: { ...LOADED_PROJECT_RESULT.project, epoch: request.epoch },
      }
    }
    api.fs.chooseFile = async () =>
      '/data/projects/demo/supraspina.project.json'
    const run = (
      runId: string,
      status: RunSnapshot['status'],
    ): RunSnapshot => ({
      runId,
      projectId: LOADED_PROJECT_RESULT.project.projectId,
      projectEpoch: 1,
      status,
      startedAt: 1,
      endedAt: status === 'running' ? null : 2,
      dryRun: false,
      durable: true,
      acknowledgements: {
        includeDeferredAndUnreviewedQc: false,
        acknowledgeMemoryAdvisory: false,
      },
      summary: {
        planned: 1,
        started: 1,
        waiting: 0,
        blocked: 0,
        skipped: 0,
        message: status,
      },
    })
    const bootstrap = vi.fn(async ({ project }) => ({
      project,
      sidecarGeneration: 1,
      sequence: 0,
      runs: [run('active-run', 'running'), run('failed-run', 'failed')],
      jobs: [],
      logTail: [],
      provision: null,
    }))
    api.runtime.bootstrap = bootstrap
    const cancel = vi.spyOn(api.pipeline, 'cancelRun')
    const resume = vi.spyOn(api.pipeline, 'resumeWorkflow')
    ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
    render(<App />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Open a saved project' }),
    )
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Open project file...' }),
    )
    await waitFor(() => expect(bootstrap).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Cancel/ }),
      ).not.toBeDisabled(),
    )

    const blocker = document.createElement('div')
    blocker.setAttribute('role', 'dialog')
    blocker.setAttribute('aria-label', 'Blocking confirmation')
    document.body.append(blocker)
    fireEvent.keyDown(window, { key: 'r' })
    fireEvent.keyDown(window, { key: 'R' })
    fireEvent.keyDown(window, { key: 'c' })

    expect(
      screen.queryByRole('dialog', {
        name: 'Review the run plan?',
      }),
    ).not.toBeInTheDocument()
    expect(resume).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()

    blocker.remove()
    fireEvent.keyDown(window, { key: 'c' })
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })
})
