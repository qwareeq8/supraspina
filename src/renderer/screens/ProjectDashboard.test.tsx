import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { AppProvider, useApp } from '../state/context'
import { getApi } from '../state/api'
import {
  RuntimeContext,
  logReplayCoverage,
  type RuntimeState,
} from '../state/runtime-state'
import { ProjectDashboard } from './ProjectDashboard'
import { makeMockCohort } from '../ipc/mock'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { RunSnapshot, WorkflowResult } from '../../shared/contract'
import { MATRIX_STEP_HELP } from '../../shared/help'
import { MATRIX_STEPS, type StepKey } from '../../shared/steps'
import {
  emptyCell,
  type JobStatus,
  type RunManifest,
  type Subject,
} from '../../shared/types'
import { formatRunTime, ICON_SIZE, statusGlyphColor, TEXT_GAP } from '../ui'

const DASHBOARD_PROJECT = {
  projectId: 'dashboard-project',
  root: '/tmp/dashboard',
  configPath: '/tmp/dashboard/supraspina.project.json',
  epoch: 1,
}

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (booted.current) return
    booted.current = true
    const cfg = titledConfig()
    cfg.paths.projectRoot = DASHBOARD_PROJECT.root
    app.markProjectCreated({
      project: DASHBOARD_PROJECT,
      cfg,
      configSha256: '0'.repeat(64),
    })
  }, [app])
  return children
}

function runManifest(
  runId: string,
  status: JobStatus,
  options: { ended?: boolean; failed?: number; subjects?: number } = {},
): RunManifest {
  return {
    runId,
    startedAt: '2026-07-22T18:00:00.000Z',
    endedAt: options.ended === false ? null : '2026-07-22T18:05:00.000Z',
    user: 'operator',
    host: 'fixture-host',
    git: { repo: 'supraspina', sha: 'abc123', dirty: false },
    configSha256: '0'.repeat(64),
    steps: [
      {
        id: 1,
        key: 'recon',
        status,
        subjects: options.subjects ?? 2,
        failed: options.failed ?? 0,
        durationSec: 10,
      },
    ],
    tools: {},
  }
}

/** Build a run manifest whose only stages are the given blocked ones. */
function blockedStagesManifest(
  runId: string,
  keys: readonly StepKey[],
): RunManifest {
  return {
    ...runManifest(runId, 'blocked'),
    steps: keys.map((key, index) => ({
      id: index + 1,
      key,
      status: 'blocked' as const,
      subjects: 2,
      failed: 0,
      durationSec: 0,
    })),
  }
}

function runtimeRun(
  runId: string,
  status: RunSnapshot['status'],
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  return {
    runId,
    projectId: DASHBOARD_PROJECT.projectId,
    projectEpoch: DASHBOARD_PROJECT.epoch,
    status,
    startedAt: Date.parse('2026-07-22T18:00:00.000Z'),
    endedAt: ['planned', 'waiting', 'queued', 'running', 'cancelling'].includes(
      status,
    )
      ? null
      : Date.parse('2026-07-22T18:07:00.000Z'),
    dryRun: false,
    durable: true,
    selectedSubjectIds: ['sub-001', 'sub-002'],
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
    ...overrides,
  }
}

function renderProjectDashboard(ui: ReactNode): ReturnType<typeof render> {
  return render(
    <AppProvider>
      <Bootstrap>{ui}</Bootstrap>
    </AppProvider>,
  )
}

function renderDashboard(ui: ReactNode): ReturnType<typeof render> {
  return render(<AppProvider>{ui}</AppProvider>)
}

function RouteProbe(): ReactNode {
  const { route, subjectsFilter } = useApp()
  return (
    <output data-testid="route-probe">{`${route}:${subjectsFilter}`}</output>
  )
}

/** The Open Runs actions of the cohort notices, not the empty run history. */
function noticeRunsButtons(): HTMLElement[] {
  return screen
    .queryAllByRole('button', { name: 'Open Runs' })
    .filter((button) => button.closest('[role="status"]') !== null)
}

function titledConfig(): typeof DEFAULT_PROJECT_CONFIG {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  cfg.project.name = 'SUPRASPINA Study'
  return cfg
}

function untitledConfig(): typeof DEFAULT_PROJECT_CONFIG {
  const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
  cfg.project.name = ''
  return cfg
}

function subjectWithMemoryFailure(): Subject {
  const cells = MATRIX_STEPS.map(() => emptyCell())
  cells[0] = {
    ...emptyCell(),
    st: 'failed',
    startedAt: 1,
    finishedAt: 2,
    rc: 1,
    err: 'oom_killed',
  }
  return {
    id: 'sub-fail',
    age: 42,
    sex: 'F',
    cohort: 'SCI_P',
    ais: 'D',
    tSinceSci: 3.2,
    cells,
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
  }
}

function subjectWithReconFailure(): Subject {
  const cells = MATRIX_STEPS.map(() => emptyCell())
  cells[0] = {
    ...emptyCell(),
    st: 'failed',
    startedAt: 1,
    finishedAt: 2,
    rc: 1,
    err: 'recon_error',
  }
  return {
    id: 'sub-recon',
    age: 44,
    sex: 'M',
    cohort: 'SCI_nNP',
    ais: 'C',
    tSinceSci: 2.1,
    cells,
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
  }
}

function subjectWithRunningStep(): Subject {
  const cells = MATRIX_STEPS.map(() => emptyCell())
  cells[0] = { ...emptyCell(), st: 'running', startedAt: 1, progress: 45 }
  return {
    id: 'sub-run',
    age: 39,
    sex: 'F',
    cohort: 'SCI_P',
    ais: 'D',
    tSinceSci: 1.5,
    cells,
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
  }
}

/** Build a subject whose every matrix cell is done except the Report cell. */
function subjectFinishedExceptReport(id: string): Subject {
  const cells = MATRIX_STEPS.map((step) => ({
    ...emptyCell(),
    st: step.key === 'rep' ? ('pending' as const) : ('done' as const),
    finishedAt: step.key === 'rep' ? null : 1,
  }))
  return {
    id,
    age: 51,
    sex: 'M',
    cohort: 'CTRL',
    ais: null,
    tSinceSci: null,
    cells,
    qc: null,
    notes: '',
    registered: true,
    analysisEligible: true,
  }
}

/** Build a settled runtime projection around the supplied runs and jobs. */
function runtimeState(
  overrides: Pick<RuntimeState, 'runs' | 'jobs'>,
): RuntimeState {
  return {
    logs: [],
    logReplay: logReplayCoverage(null),
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

afterEach(() => vi.restoreAllMocks())

describe('ProjectDashboard', () => {
  it('should show a real page header matching the sibling screens', () => {
    renderDashboard(<ProjectDashboard cfg={titledConfig()} subjects={[]} />)
    expect(
      screen.getByRole('heading', { name: 'Dashboard' }),
    ).toBeInTheDocument()
    // The header is one row: the title and its actions, with no eyebrow or
    // description.
    expect(screen.queryByText('Overview')).toBeNull()
    expect(screen.queryByText(/Cohort progress, recent runs/)).toBeNull()
    expect(
      screen.queryByRole('heading', { name: 'SUPRASPINA Study' }),
    ).not.toBeInTheDocument()
  })

  it('should hold the loading state instead of an empty-cohort instruction while discovering', () => {
    // Discovery of a large project can take seconds; until it answers the
    // cohort is unknown, not empty.
    renderDashboard(
      <ProjectDashboard cfg={titledConfig()} subjects={[]} loading />,
    )
    expect(screen.queryByText('No subjects found yet.')).toBeNull()
    // The stat band holds its place while the cohort loads.
    expect(
      screen.getByRole('button', {
        name: 'Open all subjects (Subjects: loading).',
      }),
    ).toBeInTheDocument()
  })

  it('should keep the project header concise', () => {
    renderDashboard(<ProjectDashboard cfg={titledConfig()} subjects={[]} />)
    expect(screen.queryByText('Project')).not.toBeInTheDocument()
    expect(
      screen.queryByText('0 subjects . 0 done . 0 failed'),
    ).not.toBeInTheDocument()
    const refresh = screen.getByRole('button', { name: 'Refresh project' })
    expect(refresh).toBeEnabled()
    expect(refresh).toHaveAttribute(
      'title',
      'Rediscover the cohort and runs from disk.',
    )
  })

  it('should not show an untitled project fallback in the dashboard heading', () => {
    renderDashboard(<ProjectDashboard cfg={untitledConfig()} subjects={[]} />)
    expect(
      screen.getByRole('heading', { name: 'Dashboard' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Untitled project' }),
    ).not.toBeInTheDocument()
  })

  it('should call refresh from the compact dashboard action', () => {
    const refresh = vi.fn()
    renderDashboard(
      <ProjectDashboard cfg={titledConfig()} subjects={[]} refresh={refresh} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh project' }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('shows the shell rediscovery as busy and stamps the time it answers', async () => {
    // A rediscovery can run for about 18 s, so Refresh shows that it is busy.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 9, 2, 9, 0))
      vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
        items: [],
        nextCursor: null,
      })
      const answers: ((rows: Subject[]) => void)[] = []
      vi.spyOn(getApi().subjects, 'discover').mockImplementation(
        () =>
          new Promise<Subject[]>((resolve) => {
            answers.push(resolve)
          }),
      )
      function ShellDashboard(): ReactNode {
        const app = useApp()
        return (
          <ProjectDashboard
            cfg={titledConfig()}
            subjects={app.subjects}
            refresh={app.refreshSubjects}
          />
        )
      }
      renderProjectDashboard(<ShellDashboard />)
      const refresh = screen.getByRole('button', { name: 'Refresh project' })
      await waitFor(() => expect(answers.length).toBeGreaterThan(0))
      expect(refresh).toHaveAttribute('aria-busy', 'true')
      await act(async () => {
        for (const answer of answers) answer(makeMockCohort(2, 42))
      })
      await waitFor(() => expect(refresh).not.toHaveAttribute('aria-busy'))

      vi.setSystemTime(new Date(2026, 9, 2, 9, 7))
      const settled = answers.length
      fireEvent.click(refresh)
      await waitFor(() => expect(answers).toHaveLength(settled + 1))
      expect(refresh).toHaveAttribute('aria-busy', 'true')
      expect(refresh).toHaveAttribute('title', 'Refreshing the project...')
      await act(async () => answers[settled]?.(makeMockCohort(2, 42)))
      await waitFor(() =>
        expect(
          screen.getByText(
            `Last updated ${formatRunTime(new Date(2026, 9, 2, 9, 7).toISOString())}`,
          ),
        ).toBeInTheDocument(),
      )
      expect(refresh).not.toHaveAttribute('aria-busy')
    } finally {
      vi.useRealTimers()
    }
  })

  it('should keep its standalone refresh action live without a shell handler', () => {
    renderDashboard(<ProjectDashboard cfg={titledConfig()} subjects={[]} />)
    const refresh = screen.getByRole('button', { name: 'Refresh project' })
    expect(() => fireEvent.click(refresh)).not.toThrow()
  })

  it('should offer Open Setup from the empty dashboard', () => {
    renderDashboard(<ProjectDashboard cfg={titledConfig()} subjects={[]} />)
    // The title states the fact; the hint and the button carry the remedy.
    expect(screen.getByText('No subjects found yet.')).toBeInTheDocument()
    expect(
      screen.getByText('Point Setup at a BIDS or derivatives folder.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Setup' })).toHaveAttribute(
      'title',
      'Open the Setup wizard to set where your data lives, then refresh.',
    )
    expect(
      screen.queryByRole('button', { name: 'Load sample data' }),
    ).not.toBeInTheDocument()
  })

  it('sizes the empty cards to their content and ends the columns level', async () => {
    renderDashboard(<ProjectDashboard cfg={titledConfig()} subjects={[]} />)
    // No card keeps the tall empty-state floor; one stretched row ends the
    // two side cards level with Recent subjects.
    for (const message of [
      'No subjects found yet.',
      'No subjects need attention.',
      await screen.findByText('No runs yet.').then((el) => el.textContent),
    ]) {
      const state = screen.getByText(message).parentElement as HTMLElement
      expect(state.style.minHeight).toBe('')
      expect(state.style.flex).toBe('1 1 0%')
    }
    const row = screen
      .getByText('Recent subjects')
      .closest('[style*="grid-template-columns"]') as HTMLElement
    expect(row.style.alignItems).toBe('stretch')
  })

  it('hides the stat band and the legend for an empty project', () => {
    // An empty project has nothing to count or to explain.
    renderDashboard(<ProjectDashboard cfg={titledConfig()} subjects={[]} />)
    expect(
      screen.queryByRole('button', { name: /^Open all subjects/ }),
    ).toBeNull()
    expect(document.querySelector('[data-legend-glyph]')).toBeNull()
  })

  it('defines each stat tile in its tooltip', () => {
    renderDashboard(<ProjectDashboard subjects={makeMockCohort(12, 17)} />)
    expect(
      screen.getByRole('button', { name: /^Open running subjects/ }),
    ).toHaveAttribute(
      'title',
      'Open running subjects. At least one step is running or queued now.',
    )
    expect(
      screen.getByRole('button', { name: /^Open failed subjects/ }),
    ).toHaveAttribute(
      'title',
      'Open failed subjects. At least one step failed, was blocked, or was withheld.',
    )
    expect(
      screen.getByRole('button', { name: /^Open pending subjects/ }),
    ).toHaveAttribute(
      'title',
      'Open pending subjects. No step has finished for these subjects.',
    )
    expect(document.querySelector('[data-legend-glyph]')).not.toBeNull()
  })

  it('should label the completed stat tile as Done', () => {
    const cohort = makeMockCohort(12, 17)
    renderDashboard(<ProjectDashboard subjects={cohort} />)
    expect(
      screen.getByRole('button', {
        name: /^Open done subjects \(Done: \d+\)\./,
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText('All done')).not.toBeInTheDocument()
  })

  it('should roll subjects into mutually exclusive live status tiles', () => {
    const cohort: Subject[] = makeMockCohort(5, 118).map((subject) => ({
      ...subject,
      cells: subject.cells.map((cell) => ({
        ...cell,
        st: 'pending' as const,
        startedAt: null,
        finishedAt: null,
        rc: null,
        err: null,
      })),
    }))
    const failed = cohort[0]!
    failed.cells[0] = {
      ...failed.cells[0]!,
      st: 'interrupted',
      err: 'fixture interruption',
    }
    failed.cells[1] = { ...failed.cells[1]!, st: 'running' }
    cohort[1]!.cells[0] = { ...cohort[1]!.cells[0]!, st: 'cancelling' }
    cohort[2]!.cells[0] = { ...cohort[2]!.cells[0]!, st: 'waiting' }
    cohort[3] = {
      ...cohort[3]!,
      cells: cohort[3]!.cells.map((cell) => ({ ...cell, st: 'done' })),
    }
    cohort[4]!.cells[0] = { ...cohort[4]!.cells[0]!, st: 'failed' }

    renderDashboard(<ProjectDashboard subjects={cohort} />)

    expect(
      screen.getByRole('button', {
        name: /^Open failed subjects \(Failed: 1\)\.$/,
      }),
    ).toBeInTheDocument()
    // An interrupted step outranks a running one; it did not fail.
    expect(
      screen.getByRole('button', {
        name: /^Open interrupted subjects \(Interrupted: 1\)\. /,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^Open running subjects \(Running: 1\)\.$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^Open pending subjects \(Pending: 1\)\.$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^Open done subjects \(Done: 1\)\./ }),
    ).toBeInTheDocument()
    // Canceled has no subject, so it has no tile.
    expect(
      screen.queryByRole('button', { name: /^Open canceled subjects/ }),
    ).toBeNull()
    const counts = screen.getByText(
      'Subjects 5, Done 1, Out of date 0, Partly done 0, Running 1, Failed 1, Interrupted 1, Pending 1',
    )
    expect(counts).toHaveAttribute('aria-live', 'polite')
    expect(counts).not.toHaveAttribute('aria-label')
  })

  it('should count precise auxiliary-stage runtime states', () => {
    // Pass QC review, so no exclusion outranks the stage states.
    const cohort: Subject[] = makeMockCohort(3, 317).map((subject) => ({
      ...subject,
      qc: 'pass' as const,
      cells: subject.cells.map((cell) => ({
        ...cell,
        st: 'pending' as const,
        startedAt: null,
        finishedAt: null,
        rc: null,
        err: null,
      })),
    }))
    cohort[0]!.stepStates = { brainfov: 'queued' }
    cohort[1]!.stepStates = { brainfov: 'running' }
    cohort[2]!.stepStates = { brainfov: 'failed' }

    renderDashboard(<ProjectDashboard subjects={cohort} />)

    expect(
      screen.getByRole('button', {
        name: /^Open running subjects \(Running: 1\)\.$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^Open failed subjects \(Failed: 1\)\.$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^Open pending subjects \(Pending: 1\)\.$/,
      }),
    ).toBeInTheDocument()
    // The tooltip spells out the abbreviation in the stage name.
    expect(
      screen.getByRole('img', { name: 'Brain FOV preparation: queued' }),
    ).toHaveAttribute('title', 'Brain FOV (field of view) preparation: queued')
    expect(
      screen.getByRole('img', { name: 'Brain FOV preparation: running' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: 'Brain FOV preparation: failed' }),
    ).toBeInTheDocument()
  })

  it('should show readable recent-subject step headers', () => {
    const cohort = makeMockCohort(1, 17)
    renderDashboard(<ProjectDashboard subjects={cohort} />)
    expect(
      screen.getByRole('columnheader', { name: 'Reconstruction' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'Internal cortical QC' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('columnheader', { name: 'Feature extraction' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('columnheader', { name: 'qc-internal-cortical' }),
    ).not.toBeInTheDocument()
  })

  it('should explain each step column header in plain language on hover', () => {
    const cohort = makeMockCohort(1, 17)
    renderDashboard(<ProjectDashboard subjects={cohort} />)
    const recon = screen.getByRole('columnheader', { name: 'Reconstruction' })
    expect(recon).toHaveAttribute('title', MATRIX_STEP_HELP.recon)
    const pba = screen.getByRole('columnheader', { name: 'PyBrainAge' })
    expect(pba).toHaveAttribute('title', MATRIX_STEP_HELP.pba)
  })

  it('adds the BrainCharts column to the recent matrix only while the stage is on', () => {
    const cohort = makeMockCohort(2, 17)
    const view = renderDashboard(<ProjectDashboard subjects={cohort} />)
    expect(
      screen.queryByRole('columnheader', { name: 'BrainCharts' }),
    ).not.toBeInTheDocument()
    view.unmount()

    const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    cfg.steps.braincharts = { ...cfg.steps.braincharts!, enabled: true }
    renderDashboard(<ProjectDashboard subjects={cohort} cfg={cfg} />)
    const header = screen.getByRole('columnheader', { name: 'BrainCharts' })
    expect(header).toHaveAttribute('title', MATRIX_STEP_HELP.norm)
    const names = screen
      .getAllByRole('columnheader')
      .map((cell) => cell.getAttribute('aria-label'))
    expect(names.indexOf('BrainCharts')).toBe(names.indexOf('PyBrainAge') + 1)
  })

  it('should describe needs-attention failed steps with readable labels', () => {
    renderDashboard(
      <ProjectDashboard subjects={[subjectWithMemoryFailure()]} />,
    )
    const matrix = screen.getByRole('table', {
      name: 'Recent subjects status matrix',
    })
    const attentionRow = screen
      .getAllByRole('button', { name: 'Open sub-fail in QC review' })
      .find((b) => !matrix.contains(b)) as HTMLElement
    expect(within(attentionRow).getByText('Reconstruction')).toBeInTheDocument()
    expect(within(attentionRow).getByText('Out of memory')).toHaveAttribute(
      'title',
      'Out of memory',
    )
    expect(attentionRow.textContent).not.toContain('oom_killed')
    expect(
      within(attentionRow).queryByRole('img', { name: 'Failure' }),
    ).not.toBeInTheDocument()
  })

  it('states a needs-attention reason as Logs does', () => {
    const persisted = subjectWithMemoryFailure()
    persisted.cells[0] = { ...persisted.cells[0]!, err: 'persistence_error' }
    const separator = subjectWithReconFailure()
    separator.cells[0] = { ...separator.cells[0]!, err: '-'.repeat(58) }
    renderDashboard(<ProjectDashboard subjects={[persisted, separator]} />)
    const matrix = screen.getByRole('table', {
      name: 'Recent subjects status matrix',
    })
    const attentionRow = (id: string): HTMLElement =>
      screen
        .getAllByRole('button', { name: `Open ${id} in QC review` })
        .find((b) => !matrix.contains(b)) as HTMLElement

    // A reason code reads as its sentence, whole in the title.
    const stated = "Supraspina could not persist this job's state."
    expect(within(attentionRow('sub-fail')).getByText(stated)).toHaveAttribute(
      'title',
      stated,
    )
    expect(attentionRow('sub-fail').textContent).not.toContain(
      'persistence_error',
    )
    // A separator line is no reason: the row names the step and its state
    // alone.
    const separatorRow = attentionRow('sub-recon')
    expect(within(separatorRow).getByText('Reconstruction')).toBeInTheDocument()
    expect(separatorRow.textContent).not.toContain('---')
    expect(
      [...separatorRow.querySelectorAll('[title]')].map((el) =>
        el.getAttribute('title'),
      ),
    ).toEqual(['Reconstruction failed'])
  })

  it('counts interrupted and canceled subjects apart from failures', () => {
    // An app crash interrupts three reconstructions and a Cancel all cancels
    // one; no job failed, so nothing may count as a failure.
    const withStates = (
      id: string,
      states: Partial<Record<number, Subject['cells'][number]['st']>>,
      err: string | null = null,
    ): Subject => ({
      ...subjectFinishedExceptReport(id),
      cells: MATRIX_STEPS.map((_, index) => {
        const st = states[index] ?? 'pending'
        return {
          ...emptyCell(),
          st,
          finishedAt: st === 'pending' ? null : 1,
          err: st === 'done' ? null : err,
        }
      }),
    })
    const crash = { 0: 'interrupted' } as const
    const cohort = [
      withStates('sub-101', crash),
      withStates('sub-901', crash),
      withStates('sub-902', crash),
      withStates(
        'sub-906',
        { 0: 'cancelled' },
        "Canceled at the operator's request.",
      ),
    ]

    renderDashboard(<ProjectDashboard subjects={cohort} />)

    expect(
      screen.getByRole('button', {
        name: /^Open failed subjects \(Failed: 0\)\.$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^Open interrupted subjects \(Interrupted: 3\)\. /,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^Open canceled subjects \(Canceled: 1\)\. /,
      }),
    ).toBeInTheDocument()
    // Needs attention counts and words each row by its state, failures first.
    expect(screen.getByText('3 interrupted, 1 canceled')).toBeInTheDocument()
    expect(screen.queryByText(/with failures/)).toBeNull()
    const matrix = screen.getByRole('table', {
      name: 'Recent subjects status matrix',
    })
    const rows = screen
      .getAllByRole('button', { name: /^Open sub-\d+ in QC review$/ })
      .filter((button) => !matrix.contains(button))
    expect(
      rows.map((row) => [
        row.getAttribute('aria-label'),
        row.getAttribute('aria-describedby') &&
          document.getElementById(row.getAttribute('aria-describedby')!)
            ?.textContent,
      ]),
    ).toEqual([
      ['Open sub-101 in QC review', 'Reconstruction interrupted'],
      ['Open sub-901 in QC review', 'Reconstruction interrupted'],
      ['Open sub-902 in QC review', 'Reconstruction interrupted'],
      ['Open sub-906 in QC review', 'Reconstruction canceled'],
    ])
    // A cancellation reason is no failure: it reads in the quiet tone of the
    // step text, not in the failure color.
    const reason = within(rows[3]!).getByText(
      "Canceled at the operator's request.",
    )
    const step = document.getElementById(
      rows[3]!.getAttribute('aria-describedby')!,
    )!
    expect(reason.style.color).toBe(step.style.color)
    expect(screen.queryByText(/sub-\d+ failed/)).toBeNull()
  })

  it('leaves the failed steps of a QC Fail subject out of Needs attention', () => {
    // A QC Fail subject counts as Excluded whatever its steps show, so its
    // failed step neither counts nor lists beside a Failed tile of 1.
    const failedRecon = (id: string): Subject => ({
      ...subjectFinishedExceptReport(id),
      cells: MATRIX_STEPS.map((_, index) => ({
        ...emptyCell(),
        st: index === 0 ? 'failed' : 'pending',
        finishedAt: index === 0 ? 1 : null,
      })),
    })
    const cohort = [
      failedRecon('sub-201'),
      { ...failedRecon('sub-202'), qc: 'fail' as const },
    ]

    renderDashboard(<ProjectDashboard subjects={cohort} />)

    expect(
      screen.getByRole('button', {
        name: /^Open failed subjects \(Failed: 1\)\./,
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    const matrix = screen.getByRole('table', {
      name: 'Recent subjects status matrix',
    })
    const rows = screen
      .getAllByRole('button', { name: /^Open sub-\d+ in QC review$/ })
      .filter((button) => !matrix.contains(button))
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Open sub-201 in QC review',
    ])
  })

  it('draws the focus ring of every list row inside its border', async () => {
    // Recent runs and Needs attention scroll on their own, and their scroll box
    // would cut off the top of a ring drawn outside the first row at 1214x768
    // and 135% text.
    const run = runtimeRun('run-done', 'done')
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [runManifest('run-done', 'done')],
      nextCursor: null,
    })
    renderProjectDashboard(
      <RuntimeContext.Provider
        value={runtimeState({
          runs: [run],
          jobs: [
            {
              id: 'job-other',
              runId: 'run-done',
              stepKey: 'recon',
              subjectId: 'sub-other',
              startedAt: Date.parse('2026-07-22T18:01:00.000Z'),
              endedAt: Date.parse('2026-07-22T18:04:00.000Z'),
              exitCode: 0,
              cmd: '',
              stdoutPath: '',
              stderrPath: '',
              envSnapshotPath: '',
              configSnapshotPath: '',
              status: 'done',
            },
          ],
        })}
      >
        <ProjectDashboard
          subjects={[subjectWithReconFailure()]}
          runtimeRuns={[run]}
        />
      </RuntimeContext.Provider>,
    )

    const openRun = await screen.findByRole('button', {
      name: /^Open this run in Logs/,
    })
    const matrix = screen.getByRole('table', {
      name: 'Recent subjects status matrix',
    })
    const attentionRow = screen
      .getAllByRole('button', { name: 'Open sub-recon in QC review' })
      .find((button) => !matrix.contains(button))!
    expect(openRun.style.outlineOffset).toBe('-2px')
    expect(attentionRow.style.outlineOffset).toBe('-2px')
  })

  it('should match needs-attention step labels to table labels', () => {
    renderDashboard(<ProjectDashboard subjects={[subjectWithReconFailure()]} />)
    const matrix = screen.getByRole('table', {
      name: 'Recent subjects status matrix',
    })
    const attentionRow = screen
      .getAllByRole('button', { name: 'Open sub-recon in QC review' })
      .find((b) => !matrix.contains(b)) as HTMLElement
    expect(within(attentionRow).getByText('Reconstruction')).toBeInTheDocument()
    expect(
      within(attentionRow).queryByText('Recon-all'),
    ).not.toBeInTheDocument()
  })

  it('should color a running matrix cell blue, never the green done/accent color', () => {
    renderDashboard(<ProjectDashboard subjects={[subjectWithRunningStep()]} />)
    const cell = screen.getByLabelText(/^Reconstruction: running/)
    const running = cell.querySelector('svg')?.getAttribute('stroke') ?? ''
    expect(running).toMatch(/58,111,224|#3a6fe0|91,141,239|#5b8def/i)
    expect(running).not.toMatch(/70,185,138|#46b98a|31,90,65|#1f5a41/i)
    expect(running).not.toMatch(/61,166,113|#3da671|30,122,77|#1e7a4d/i)
  })

  it('should cap the recent-subjects preview at ten rows', () => {
    const cohort = makeMockCohort(12, 17)
    renderDashboard(<ProjectDashboard subjects={cohort} />)
    expect(
      screen.queryByRole('button', { name: 'Show more recent subjects.' }),
    ).not.toBeInTheDocument()
    const matrix = screen.getByRole('table', {
      name: 'Recent subjects status matrix',
    })
    const openButtons = within(matrix).getAllByRole('button', {
      name: /^Open .* in QC review$/,
    })
    expect(openButtons).toHaveLength(10)
    expect(screen.queryByText('10 of 12 shown')).not.toBeInTheDocument()
    expect(screen.queryByText('latest 10')).not.toBeInTheDocument()
  })

  it('should scroll a clipped recent-subjects matrix and mark the hidden columns', () => {
    // Match the measured 1214 px window, where the status columns overflow.
    const isRegion = (el: Element): boolean =>
      el.getAttribute('aria-label') === 'Recent subjects table'
    const scrollWidth = vi
      .spyOn(Element.prototype, 'scrollWidth', 'get')
      .mockImplementation(function (this: Element) {
        return isRegion(this) ? 760 : 0
      })
    const clientWidth = vi
      .spyOn(Element.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: Element) {
        return isRegion(this) ? 560 : 0
      })
    try {
      const { container } = renderDashboard(
        <ProjectDashboard subjects={makeMockCohort(3, 17)} />,
      )
      const region = screen.getByRole('region', {
        name: 'Recent subjects table',
      })
      expect(region).toHaveStyle({ overflowX: 'auto' })
      const matrix = within(region).getByRole('table', {
        name: 'Recent subjects status matrix',
      })
      const [header, firstRow] = within(matrix).getAllByRole('row')
      expect(
        within(header!).getByRole('columnheader', { name: 'Subject' }),
      ).toHaveStyle({ position: 'sticky' })
      expect(within(firstRow!).getByRole('rowheader')).toHaveStyle({
        position: 'sticky',
      })
      expect(
        container.querySelector('[data-scroll-edge="right"]'),
      ).not.toBeNull()
      expect(container.querySelector('[data-scroll-edge="left"]')).toBeNull()
      // The chevron sits in a gutter beside the table, not over its last
      // visible column.
      expect(
        container.querySelector('[data-scroll-edge="right"] svg'),
      ).toBeNull()
      expect(
        container.querySelector('[data-scroll-edge="right-chevron"] svg'),
      ).not.toBeNull()
      expect(region.parentElement).toHaveStyle({ paddingRight: '16px' })

      region.scrollLeft = 200
      fireEvent.scroll(region)
      expect(
        container.querySelector('[data-scroll-edge="left"]'),
      ).not.toBeNull()
      expect(container.querySelector('[data-scroll-edge="right"]')).toBeNull()
    } finally {
      scrollWidth.mockRestore()
      clientWidth.mockRestore()
    }
  })

  it('should show no scroll edge when every recent-subject column fits', () => {
    const { container } = renderDashboard(
      <ProjectDashboard subjects={makeMockCohort(3, 17)} />,
    )
    screen.getByRole('table', { name: 'Recent subjects status matrix' })
    expect(container.querySelector('[data-scroll-edge]')).toBeNull()
  })

  it('grows the Recent subjects header to hold its legend, loading or loaded', () => {
    // At 1214x768 and 135% text a fixed header cannot hold the title, the
    // loading tag, and the legend.
    const cohort = makeMockCohort(3, 17)
    const { rerender } = renderDashboard(
      <ProjectDashboard subjects={cohort} loading />,
    )
    const titleRow = (): { title: HTMLElement; row: HTMLElement } => {
      const title = screen.getByRole('heading', { name: 'Recent subjects' })
      const row = title.parentElement
      if (!row) throw new Error('Render the Recent subjects title row.')
      return { title, row }
    }
    const expectGrowingRow = (): HTMLElement => {
      const { title, row } = titleRow()
      expect(row.style.height).toBe('')
      expect(row.style.minHeight).toBe('var(--ss-card-header)')
      expect(row.style.flexWrap).toBe('wrap')
      expect(title.style.whiteSpace).toBe('nowrap')
      expect(row.querySelector('[data-legend-glyph="outdated"]')).not.toBeNull()
      return row
    }

    const loadingRow = expectGrowingRow()
    expect(within(loadingRow).getByText('loading')).toBeInTheDocument()

    rerender(
      <AppProvider>
        <ProjectDashboard subjects={cohort} />
      </AppProvider>,
    )
    screen.getByRole('table', { name: 'Recent subjects status matrix' })
    const loadedRow = expectGrowingRow()
    expect(within(loadedRow).queryByText('loading')).toBeNull()

    // The panels with an expand button keep the fixed header height.
    for (const name of ['Recent runs', 'Needs attention']) {
      const row = screen.getByRole('heading', { name }).parentElement
      expect(row?.style.height).toBe('var(--ss-card-header)')
      expect(row?.style.flexWrap).toBe('')
    }
  })

  it('should route from the bounded preview to the full subjects matrix', () => {
    const cohort = makeMockCohort(12, 53)
    renderDashboard(
      <>
        <ProjectDashboard subjects={cohort} />
        <RouteProbe />
      </>,
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'View all 12 subjects' }),
    )
    expect(screen.getByTestId('route-probe')).toHaveTextContent('subjects:all')
  })

  it('should expose hover and focus feedback without changing row actions', () => {
    renderDashboard(<ProjectDashboard subjects={makeMockCohort(1, 55)} />)
    const tile = screen.getByRole('button', {
      name: /^Open all subjects \(Subjects: 1\)\.$/,
    })
    fireEvent.mouseEnter(tile)
    expect(tile).toHaveStyle({ cursor: 'pointer' })
    fireEvent.mouseLeave(tile)

    const matrix = screen.getByRole('table', {
      name: 'Recent subjects status matrix',
    })
    const open = within(matrix).getByRole('button', {
      name: 'Open sub-001 in QC review',
    })
    const row = open.closest('[role="row"]')!
    fireEvent.mouseEnter(row)
    fireEvent.focus(open)
    fireEvent.blur(open)
    fireEvent.mouseLeave(row)
    expect(open).toHaveAttribute('title', 'Open sub-001 in QC review')
  })

  it('should summarize blocked, running, failed, and completed manifests', async () => {
    const api = getApi()
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [
        runManifest('blocked-run', 'blocked'),
        runManifest('running-run', 'running', { ended: false }),
        runManifest('failed-run', 'failed', { failed: 1, subjects: 1 }),
        runManifest('done-run', 'done'),
        runManifest('empty-run', 'done', { subjects: 0 }),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard subjects={makeMockCohort(1, 57)} />,
    )

    expect(await screen.findByRole('img', { name: 'Run blocked' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Run in progress' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Run failed' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Run completed' })).toBeNull()
    for (const item of screen.getAllByRole('listitem')) {
      const tooltip = item.getAttribute('title') ?? ''
      expect(tooltip).not.toMatch(/(blocked|running|failed|done|empty)-run/)
      expect(tooltip).not.toContain('abc123')
    }

    fireEvent.click(
      screen.getByRole('button', { name: 'Show more recent runs.' }),
    )
    expect(screen.getAllByRole('img', { name: 'Run completed' })).toHaveLength(
      2,
    )
    expect(screen.getByText(/1 failure.*1 subject/)).toBeInTheDocument()
    expect(
      screen.getByText(/Reconstruction blocked.*2 subjects/),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show fewer recent runs.' }),
    )
    expect(screen.queryByText('empty-run')).toBeNull()
  })

  it('draws each run outcome with its matrix legend glyph and names it', async () => {
    // Each outcome draws its own legend glyph: a blocked run is not the Failed
    // cross, and a failed, canceled, or interrupted run is not the "Run needs
    // review" warning triangle.
    const outcomes = [
      ['failed', 'Run failed', 'cross-ring'],
      ['blocked', 'Run blocked', 'prohibited'],
      ['cancelled', 'Run canceled', 'stop-ring'],
      ['interrupted', 'Run interrupted', 'bolt'],
      ['withheld', 'Run withheld', 'pause'],
      ['done', 'Run completed', 'check-ring'],
    ] as const
    // Read each outcome's legend tone from the theme the dashboard draws in.
    function LegendToneProbe(): ReactNode {
      const { t } = useApp()
      return (
        <output data-testid="legend-tones">
          {JSON.stringify(
            Object.fromEntries(
              outcomes.map(([status]) => [status, statusGlyphColor(t, status)]),
            ),
          )}
        </output>
      )
    }
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: outcomes.map(([status]) => runManifest(`${status}-run`, status)),
      nextCursor: null,
    })
    renderProjectDashboard(
      <>
        <LegendToneProbe />
        <ProjectDashboard
          subjects={makeMockCohort(1, 57)}
          runtimeRuns={outcomes.map(([status]) =>
            runtimeRun(`${status}-run`, status),
          )}
        />
      </>,
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show more recent runs.' }),
    )

    const tones = JSON.parse(
      screen.getByTestId('legend-tones').textContent ?? '{}',
    ) as Record<string, string>
    for (const [status, name, shape] of outcomes) {
      const icon = screen.getByRole('img', { name })
      expect(icon.querySelector('[data-glyph-shape]')).toHaveAttribute(
        'data-glyph-shape',
        shape,
      )
      expect(icon).toHaveStyle({ color: tones[status] })
    }
    expect(screen.queryByRole('img', { name: 'Run needs review' })).toBeNull()
  })

  it('draws a storage error at the size and stroke of the legend glyphs', async () => {
    // The warning sign matches the legend glyphs in size and stroke.
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        runManifest('storage-run', 'failed'),
        runManifest('failed-run', 'failed'),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard
        subjects={makeMockCohort(1, 57)}
        runtimeRuns={[
          runtimeRun('storage-run', 'persistence-error'),
          runtimeRun('failed-run', 'failed'),
        ]}
      />,
    )

    const sign = (
      await screen.findByRole('img', { name: 'Run storage error' })
    ).querySelector('svg')
    const legendGlyph = screen
      .getByRole('img', { name: 'Run failed' })
      .querySelector('svg')
    expect(sign).toHaveAttribute('width', String(ICON_SIZE.inline))
    expect(legendGlyph).toHaveAttribute('width', String(ICON_SIZE.inline))
    expect(sign).toHaveAttribute(
      'stroke-width',
      legendGlyph?.getAttribute('stroke-width') ?? '',
    )
  })

  it('names a recent run by its start time and keeps its end time in its name', async () => {
    // The Logs Run list names a run by its start time, so a row that named it
    // by its end time would seem to open a different run.
    const failedStart = '2026-07-22T14:17:00.000Z'
    const failedEnd = '2026-07-23T16:20:00.000Z'
    const runningStart = '2026-07-24T09:05:00.000Z'
    const doneStart = '2026-07-21T08:00:00.000Z'
    const doneEnd = '2026-07-21T09:30:00.000Z'
    const failed = runtimeRun('run-failed', 'failed', {
      startedAt: Date.parse(failedStart),
      endedAt: Date.parse(failedEnd),
    })
    const running = runtimeRun('run-running', 'running', {
      startedAt: Date.parse(runningStart),
    })
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        {
          ...runManifest('run-running', 'running', { ended: false }),
          startedAt: runningStart,
        },
        {
          ...runManifest('run-failed', 'failed', { failed: 1 }),
          startedAt: failedStart,
          endedAt: failedEnd,
        },
        {
          ...runManifest('run-done', 'done'),
          startedAt: doneStart,
          endedAt: doneEnd,
        },
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <RuntimeContext.Provider
        value={runtimeState({
          runs: [running, failed],
          jobs: [
            {
              id: 'job-failed',
              runId: 'run-failed',
              stepKey: 'recon',
              subjectId: 'sub-001',
              startedAt: Date.parse(failedStart),
              endedAt: Date.parse(failedEnd),
              exitCode: 1,
              cmd: '',
              stdoutPath: '',
              stderrPath: '',
              envSnapshotPath: '',
              configSnapshotPath: '',
              status: 'failed',
            },
          ],
        })}
      >
        <ProjectDashboard
          subjects={makeMockCohort(1, 57)}
          runtimeRuns={[running, failed]}
        />
      </RuntimeContext.Provider>,
    )

    const openFailed = await screen.findByRole('button', {
      name: /^Open this run in Logs \(Failed, /,
    })
    // The row names the run by its start time, as the Logs Run list does,
    // and says that the time is the start, so it cannot read as the time
    // the run failed.
    expect(
      within(openFailed).getByText(
        `Failed, started ${formatRunTime(failedStart)}`,
      ),
    ).toBeVisible()
    expect(openFailed).not.toHaveTextContent(formatRunTime(failedEnd))
    // The end time stays in the row's accessible name and tooltip.
    const failedEnded = `Ended ${formatRunTime(failedEnd)}`
    expect(openFailed).toHaveAccessibleName(
      `Open this run in Logs (Failed, started ${formatRunTime(failedStart)}. ${failedEnded}. 1 failure${TEXT_GAP}2 subjects).`,
    )
    expect(openFailed.getAttribute('title')).toContain(failedEnded)

    // A finished run is named by its start time too, so its title states
    // its outcome rather than a finish time.
    const done = screen.getByRole('listitem', {
      name: `Done, started ${formatRunTime(doneStart)}. Ended ${formatRunTime(doneEnd)}. 2 subjects`,
    })
    expect(done.getAttribute('title')).toContain(
      `Ended ${formatRunTime(doneEnd)}`,
    )
    expect(screen.queryByText(/^Finished /)).toBeNull()

    // A run that has not ended is named by its start alone.
    expect(
      screen.getByRole('listitem', {
        name: `Started ${formatRunTime(runningStart)}. 2 subjects`,
      }),
    ).toBeInTheDocument()

    // The list keeps its order.
    const list = openFailed.closest('[role="list"]') as HTMLElement
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => (item.textContent ?? '').split(/[ ,]/)[0]),
    ).toEqual(['Started', 'Failed', 'Done'])
  })

  it('draws a manifest-only run with the glyph of its outcome', async () => {
    // Without a runtime snapshot a run with a failure still draws its own
    // glyph, and a canceled run does not read as completed.
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        runManifest('failed-run', 'failed', { failed: 1 }),
        runManifest('cancelled-run', 'cancelled'),
        runManifest('interrupted-run', 'interrupted'),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard subjects={makeMockCohort(1, 57)} />,
    )

    expect(
      await screen.findByRole('listitem', {
        name: /^Failed, .*\. 1 failure\s2 subjects$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', { name: /^Canceled, .*\. 2 subjects$/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', { name: /^Interrupted, .*\. 2 subjects$/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Run failed' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Run canceled' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Run interrupted' })).toBeVisible()
    expect(screen.queryByRole('img', { name: 'Run completed' })).toBeNull()
  })

  it('states a manifest-only run whose outcome was not recorded as such', async () => {
    // Without a runtime snapshot, a run whose stages ended unknown, stale, or
    // with a storage error must not read "Done" with the check.
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        runManifest('unknown-run', 'unknown', { ended: false }),
        runManifest('stale-run', 'stale'),
        runManifest('storage-run', 'persistence-error'),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard subjects={makeMockCohort(1, 57)} />,
    )

    expect(
      await screen.findByRole('listitem', {
        name: /^Unknown, .*\. runtime status unknown\s2 subjects$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', {
        name: /^Stale, .*\. stale runtime state\s2 subjects$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', {
        name: /^Storage error, .*\. runtime storage error\s2 subjects$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', { name: 'Run status unknown' }),
    ).toBeVisible()
    expect(
      screen.getByRole('img', { name: 'Run state is stale' }),
    ).toBeVisible()
    expect(screen.getByRole('img', { name: 'Run storage error' })).toBeVisible()
    expect(screen.queryByRole('img', { name: 'Run completed' })).toBeNull()
    expect(screen.queryByRole('img', { name: 'Run in progress' })).toBeNull()
  })

  it('ranks a manifest-only run outcome as the sidecar ranks a run status', async () => {
    // The sidecar ranks a failure or a cancellation above a block, and an
    // unknown stage above them all; the manifest path ranks them the same.
    const withSteps = (
      runId: string,
      statuses: readonly JobStatus[],
      failed = 0,
    ): RunManifest => ({
      ...runManifest(runId, 'done'),
      steps: statuses.map((status, index) => ({
        id: index + 1,
        key: (['recon', 'enigma', 'pybrainage'] as const)[index] ?? 'recon',
        status,
        subjects: 2,
        failed: status === 'failed' ? failed : 0,
        durationSec: 10,
      })),
    })
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        withSteps('failed-blocked', ['failed', 'blocked'], 1),
        withSteps('cancelled-blocked', ['cancelled', 'blocked']),
        withSteps('blocked-interrupted', ['interrupted', 'blocked']),
        withSteps('unknown-failed', ['failed', 'unknown'], 1),
        withSteps('failed-status-only', ['failed']),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard subjects={makeMockCohort(1, 57)} />,
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Show more recent runs.' }),
    )
    const start = `, started ${formatRunTime('2026-07-22T18:00:00.000Z')}`
    expect(
      screen.getAllByRole('listitem').map((item) => {
        const name = item.getAttribute('aria-label') ?? ''
        return name.slice(0, name.indexOf(start))
      }),
    ).toEqual(['Failed', 'Canceled', 'Blocked', 'Unknown', 'Failed'])
  })

  it('names the subjects of a blocked run reason from the plan that started it', async () => {
    // The row of a plan-blocked output conflict names its subject, as the Runs
    // notice names sub-902.
    const conflict =
      'Choose a fresh derivatives namespace because detector-complete Reconstruction output has no matching current receipt; preserve the existing tree.'
    const summary: RunSnapshot['summary'] = {
      planned: 1,
      started: 1,
      waiting: 0,
      blocked: 1,
      skipped: 0,
      message: `This pass runs 1 node; 1 blocked node will not run. ${conflict}`,
    }
    const subjectIds = ['sub-901', 'sub-902']
    // A started run whose plan blocks one subject's Reconstruction.
    const started = (runId: string, blockedId: string): WorkflowResult => ({
      runId,
      disposition: 'started',
      plan: {
        planId: `plan-${runId}`,
        analysisCohort: { subjectIds, sha256: '1'.repeat(64) },
        selectedSubset: { subjectIds, sha256: '2'.repeat(64) },
        nodes: subjectIds.map((subjectId) => ({
          nodeId: `recon-${subjectId}`,
          stepKey: 'recon',
          scope: 'subject',
          subjectId,
          dependencies: [],
          ...(subjectId === blockedId
            ? { status: 'blocked' as const, reason: conflict }
            : { status: 'planned' as const }),
        })),
        blockers: [],
        summary,
      },
      summary,
    })
    const outcome = started('conflict-run', 'sub-902')
    // A later run blocks the other subject for the same reason.
    const later = started('later-run', 'sub-901')
    // The launch that started the conflict run: the execution service keeps
    // its plan records and Runs its outcome. Then the controls that prepare
    // another plan and start a later run.
    function RunsOutcome(): ReactNode {
      const { projectRef, recordRunPlan, setRunsFeedback, trackPlan } = useApp()
      useEffect(() => {
        if (!projectRef) return
        recordRunPlan(outcome)
        setRunsFeedback((previous) => ({ ...previous, outcome }))
      }, [projectRef, recordRunPlan, setRunsFeedback])
      return (
        <>
          <button
            type="button"
            onClick={() =>
              trackPlan({
                label: 'Planning the workflow...',
                waitReason: 'Supraspina is planning the workflow.',
                card: null,
              })(true)
            }
          >
            Plan again
          </button>
          <button
            type="button"
            onClick={() => {
              recordRunPlan(later)
              setRunsFeedback((previous) => ({ ...previous, outcome: later }))
            }}
          >
            Start a later run
          </button>
        </>
      )
    }
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        runManifest('conflict-run', 'blocked'),
        runManifest('earlier-run', 'blocked'),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <>
        <RunsOutcome />
        <ProjectDashboard
          subjects={makeMockCohort(1, 57)}
          runtimeRuns={[
            runtimeRun('conflict-run', 'blocked', { summary }),
            runtimeRun('earlier-run', 'blocked', { summary }),
          ]}
        />
      </>,
    )

    const named = `Reconstruction for sub-902: ${conflict} 2 subjects`
    expect(await screen.findByText(named)).toBeInTheDocument()
    // No plan or job of the earlier run records the reason, so it reads as
    // recorded rather than naming another run's subject.
    expect(screen.getByText(`${conflict} 2 subjects`)).toBeInTheDocument()

    // Any control that prepares a plan clears the Runs outcome, a read-only
    // review with Allow live runs off included, and a later run replaces it;
    // neither changes what the conflict run recorded.
    fireEvent.click(screen.getByRole('button', { name: 'Plan again' }))
    expect(screen.getByText(named)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start a later run' }))
    expect(screen.getByText(named)).toBeInTheDocument()
  })

  it('names the subjects of a blocked run reason from the run record after a relaunch', async () => {
    // After a relaunch no plan of the run is at hand, and a plan-time blocked
    // node never became a job. The run snapshot lists the nodes behind the
    // quoted reason from the run's committed graph.
    const conflict =
      'Choose a fresh derivatives namespace because detector-complete Reconstruction output has no matching current receipt; preserve the existing tree.'
    const summary: RunSnapshot['summary'] = {
      planned: 1,
      started: 1,
      waiting: 0,
      blocked: 1,
      skipped: 0,
      message: `This pass runs 1 node; 1 blocked node will not run. ${conflict}`,
    }
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        runManifest('conflict-run', 'blocked'),
        runManifest('earlier-run', 'blocked'),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard
        subjects={makeMockCohort(1, 57)}
        runtimeRuns={[
          runtimeRun('conflict-run', 'blocked', {
            summary,
            quotedReasonNodes: [
              {
                stepKey: 'recon',
                subjectId: 'sub-902',
                status: 'blocked',
                reason: conflict,
              },
            ],
          }),
          // A snapshot that lists no nodes: its reason reads as recorded.
          runtimeRun('earlier-run', 'blocked', { summary }),
        ]}
      />,
    )

    expect(
      await screen.findByText(
        `Reconstruction for sub-902: ${conflict} 2 subjects`,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(`${conflict} 2 subjects`)).toBeInTheDocument()
  })

  it('names the subjects of a reason the scheduler recorded on the run jobs', async () => {
    const reason =
      'Resolve the integrity check failure: Recheck unknown detector evidence.'
    const run = runtimeRun('deface-run', 'blocked', {
      summary: {
        planned: 0,
        started: 0,
        waiting: 0,
        blocked: 2,
        skipped: 0,
        message: `Resolve 2 blocked nodes. ${reason}`,
      },
    })
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [blockedStagesManifest('deface-run', ['deface'])],
      nextCursor: null,
    })
    renderProjectDashboard(
      <RuntimeContext.Provider
        value={runtimeState({
          runs: [run],
          jobs: ['sub-002', 'sub-001'].map((subjectId) => ({
            id: `job-deface-${subjectId}`,
            runId: 'deface-run',
            stepKey: 'deface',
            subjectId,
            startedAt: null,
            endedAt: Date.parse('2026-07-22T18:06:00.000Z'),
            exitCode: null,
            cmd: '',
            stdoutPath: '',
            stderrPath: '',
            envSnapshotPath: '',
            configSnapshotPath: '',
            status: 'blocked',
            terminalReason: reason,
          })),
        })}
      >
        <ProjectDashboard
          subjects={makeMockCohort(1, 57)}
          runtimeRuns={[run]}
        />
      </RuntimeContext.Provider>,
    )

    expect(
      await screen.findByText(
        'Optional defacing for sub-001 and sub-002: The integrity check failed: The detector evidence is unknown. 2 subjects',
      ),
    ).toBeInTheDocument()
  })

  it('states a canceled or interrupted run outcome once', async () => {
    // The title states the outcome, so the detail line does not repeat it.
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        runManifest('cancelled-run', 'running', { ended: false }),
        runManifest('interrupted-run', 'running', { ended: false }),
        runManifest('stopped-failed-run', 'running', {
          ended: false,
          failed: 1,
        }),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard
        subjects={makeMockCohort(1, 57)}
        runtimeRuns={[
          runtimeRun('cancelled-run', 'cancelled'),
          runtimeRun('interrupted-run', 'interrupted'),
          runtimeRun('stopped-failed-run', 'cancelled'),
        ]}
      />,
    )

    expect(
      await screen.findByRole('listitem', {
        name: /^Canceled, .*\. 2 subjects$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', { name: /^Interrupted, .*\. 2 subjects$/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', {
        name: /^Canceled, .*\. 1 failure\s2 subjects$/,
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^(canceled|interrupted)\s/)).toBeNull()
  })

  it('lists a finished dry run as a dry-run plan, not a run in progress', async () => {
    // Nothing runs in a dry run, so a finished one is neither a run in progress
    // nor, without a runtime snapshot, a completed run; Logs names it "Dry-run
    // plan".
    const dryRun = (runId: string): RunManifest => ({
      ...runManifest(runId, 'planned'),
      dryRun: true,
    })
    // Read the neutral tone from the theme the dashboard draws in.
    function NeutralToneProbe(): ReactNode {
      const { t } = useApp()
      return <output data-testid="neutral-tone">{t.dim}</output>
    }
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [dryRun('dry-live'), dryRun('dry-manifest')],
      nextCursor: null,
    })
    renderProjectDashboard(
      <>
        <NeutralToneProbe />
        <ProjectDashboard
          subjects={makeMockCohort(1, 57)}
          runtimeRuns={[
            runtimeRun('dry-live', 'planned', {
              dryRun: true,
              durable: false,
              endedAt: Date.parse('2026-07-22T18:00:00.000Z'),
            }),
          ]}
        />
      </>,
    )

    const rows = await screen.findAllByRole('listitem', {
      name: /^Dry-run plan, .*\. 2 subjects$/,
    })
    expect(rows).toHaveLength(2)
    const icons = screen.getAllByRole('img', {
      name: 'Dry-run plan: nothing ran',
    })
    expect(icons).toHaveLength(2)
    // The legend's own planned ring, drawn in the neutral tone.
    const neutral = screen.getByTestId('neutral-tone').textContent ?? ''
    for (const icon of icons) {
      expect(
        icon.querySelector('[data-glyph-shape="dashed-ring"]'),
      ).toHaveAttribute('stroke', neutral)
    }
    expect(screen.queryByRole('img', { name: 'Run in progress' })).toBeNull()
    expect(screen.queryByRole('img', { name: 'Run completed' })).toBeNull()
    expect(screen.queryByRole('listitem', { name: /^Planned / })).toBeNull()
  })

  it('should count a cohort run from its manifest subject set, not its one cohort node', async () => {
    // A cohort run over 82 subjects has one cohort node but must not read "1
    // subject".
    const subjectIds = Array.from(
      { length: 82 },
      (_, index) => `sub-${String(index + 1).padStart(3, '0')}`,
    )
    const cohortRun: RunManifest = {
      ...runManifest('cohort-run', 'done', { subjects: 1 }),
      steps: [
        {
          id: 1,
          key: 'final',
          status: 'done',
          subjects: 1,
          failed: 0,
          durationSec: 10,
        },
      ],
      selectedSubset: { subjectIds, sha256: '1'.repeat(64) },
    }
    const legacyRun: RunManifest = {
      ...runManifest('legacy-run', 'done', { subjects: 1 }),
      endedAt: '2026-07-22T17:05:00.000Z',
      steps: [
        {
          id: 1,
          key: 'recon',
          status: 'done',
          subjects: 4,
          failed: 0,
          durationSec: 10,
        },
        {
          id: 2,
          key: 'final',
          status: 'done',
          subjects: 1,
          failed: 0,
          durationSec: 10,
        },
      ],
    }
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [cohortRun, legacyRun],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard subjects={makeMockCohort(1, 57)} />,
    )

    expect(
      await screen.findByRole('listitem', {
        name: /^Done, .*\. 82 subjects$/,
      }),
    ).toBeInTheDocument()
    // A manifest without cohort fields keeps the largest stage count.
    expect(
      screen.getByRole('listitem', { name: /^Done, .*\. 4 subjects$/ }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('listitem', { name: /1 subject$/ })).toBeNull()
  })

  it('should override stale recent-run manifests with matching runtime truth', async () => {
    const api = getApi()
    const manifests = [
      runManifest('later-failed', 'running', {
        ended: false,
        failed: 1,
        subjects: 2,
      }),
      runManifest('still-active', 'done', { subjects: 2 }),
      runManifest('later-blocked', 'running', {
        ended: false,
        subjects: 2,
      }),
    ]
    const originalManifests = structuredClone(manifests)
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: manifests,
      nextCursor: null,
    })

    renderProjectDashboard(
      <ProjectDashboard
        subjects={makeMockCohort(1, 159)}
        runtimeRuns={[
          runtimeRun('later-failed', 'failed'),
          runtimeRun('still-active', 'cancelling'),
          runtimeRun('later-blocked', 'blocked'),
        ]}
      />,
    )

    expect(
      await screen.findByRole('listitem', {
        name: /Failed, .*1 failure.*2 subjects/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', { name: /Canceling, .*2 subjects/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', { name: /Blocked, .*blocked.*2 subjects/ }),
    ).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Run failed' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Run in progress' })).toBeVisible()
    expect(screen.getByRole('img', { name: 'Run blocked' })).toBeVisible()
    expect(
      screen.queryByRole('img', { name: 'Run completed' }),
    ).not.toBeInTheDocument()
    expect(manifests).toEqual(originalManifests)
  })

  it('should keep a blocked run reason whole across a path and end it at a real sentence end', async () => {
    // A period inside "metadata.csv" does not end the sentence.
    const pathReason =
      'Provide the metadata file /home/u/proj/metadata/metadata.csv with a ' +
      'subject ID column (participant_id) and a Cohort column; Sex and Age ' +
      'are optional.'
    const firstSentence = 'Rerun aggregate before final.'
    const blockedSummary = (message: string): RunSnapshot['summary'] => ({
      planned: 0,
      started: 10,
      waiting: 0,
      blocked: 1,
      skipped: 0,
      message: `This pass runs 10 nodes; 1 blocked node will not run. ${message}`,
    })
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        runManifest('path-run', 'blocked'),
        runManifest('two-sentence-run', 'blocked'),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard
        subjects={makeMockCohort(1, 57)}
        runtimeRuns={[
          runtimeRun('path-run', 'blocked', {
            summary: blockedSummary(pathReason),
          }),
          runtimeRun('two-sentence-run', 'blocked', {
            summary: blockedSummary(
              `${firstSentence} Open Runs to review the stale receipt.`,
            ),
          }),
        ]}
      />,
    )

    expect(
      await screen.findByText(`${pathReason} 2 subjects`),
    ).toBeInTheDocument()
    expect(screen.getByText(`${firstSentence} 2 subjects`)).toBeInTheDocument()
    expect(screen.queryByText(/stale receipt/)).toBeNull()
  })

  it('should name the stages a run withheld beside the stages it blocked', async () => {
    // Naming blocked stages alone would make a run whose failure policy
    // withheld later stages read as if those stages had run, and a run that
    // only withheld stages would show the raw word "blocked".
    const stages = (
      runId: string,
      steps: readonly [StepKey, 'blocked' | 'withheld' | 'failed'][],
    ): RunManifest => ({
      ...runManifest(runId, 'blocked'),
      steps: steps.map(([key, status], index) => ({
        id: index + 1,
        key,
        status,
        subjects: 2,
        failed: status === 'failed' ? 1 : 0,
        durationSec: 0,
      })),
    })
    const blockedSummary = (
      blocked: number,
      message: string,
    ): RunSnapshot['summary'] => ({
      planned: 0,
      started: 0,
      waiting: 0,
      blocked,
      skipped: 0,
      message,
    })
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        stages('three-held', [
          ['recon', 'blocked'],
          ['enigma', 'withheld'],
          ['final', 'withheld'],
        ]),
        stages('one-withheld', [['final', 'withheld']]),
        stages('manifest-only', [
          ['recon', 'blocked'],
          ['enigma', 'withheld'],
        ]),
        stages('withheld-only', [['enigma', 'withheld']]),
        stages('failed-withheld', [
          ['recon', 'failed'],
          ['enigma', 'withheld'],
        ]),
      ],
      nextCursor: null,
    })
    renderProjectDashboard(
      <ProjectDashboard
        subjects={makeMockCohort(1, 57)}
        runtimeRuns={[
          // The quoted reason belongs to one of three held-back stages, so
          // the row names them all.
          runtimeRun('three-held', 'blocked', {
            summary: blockedSummary(
              3,
              `Resolve 3 blocked nodes. Brain FOV preparation failed, so this step did not run. 2 more reasons apply.`,
            ),
          }),
          runtimeRun('one-withheld', 'blocked', {
            summary: blockedSummary(
              1,
              `Resolve 1 blocked node. ENIGMA QC failed, so this step did not run.`,
            ),
          }),
        ]}
      />,
    )

    expect(
      await screen.findByText(
        'Reconstruction blocked; ENIGMA QC, R analysis withheld 2 subjects',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'R analysis did not run because ENIGMA QC failed. 2 subjects',
      ),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show more recent runs.' }),
    )
    // Without a runtime run, a manifest names both outcomes as well; work
    // withheld without a failure did not run, and work withheld after a
    // failure reads with that failure.
    expect(
      screen.getByRole('listitem', {
        name: /^Blocked, .*\. Reconstruction blocked; ENIGMA QC withheld\s2 subjects$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', {
        name: /^Blocked, .*\. ENIGMA QC withheld\s2 subjects$/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('listitem', {
        name: /^Failed, .*\. 1 failure\s2 subjects$/,
      }),
    ).toBeInTheDocument()
    for (const item of screen.getAllByRole('listitem')) {
      expect(item.getAttribute('aria-label') ?? '').not.toMatch(
        new RegExp(`(${TEXT_GAP}|\\. )blocked${TEXT_GAP}`),
      )
    }
  })

  it('should drop every summary lead-in and name the stage a blocked run did not run', async () => {
    // A row names a run, so a summary lead-in and "this step" have no referent
    // there; the row names the stage instead.
    const blockedSummary = (
      blocked: number,
      message: string,
    ): RunSnapshot['summary'] => ({
      planned: 0,
      started: 0,
      waiting: 0,
      blocked,
      skipped: 0,
      message,
    })
    const metadataReason =
      'Provide the metadata file /data/metadata.csv with a Cohort column.'
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [
        blockedStagesManifest('one-stage', ['enigma']),
        blockedStagesManifest('two-stages', ['enigma', 'outliers']),
        blockedStagesManifest('metadata', ['final']),
        blockedStagesManifest('two-reasons', ['recon']),
      ],
      nextCursor: null,
    })
    // A subject that waits on no cohort stage: the wait notice, whose
    // headline names the stage its reason calls "this step", stays away.
    renderProjectDashboard(
      <ProjectDashboard
        subjects={[subjectWithReconFailure()]}
        runtimeRuns={[
          runtimeRun('one-stage', 'blocked', {
            summary: blockedSummary(
              1,
              `Resolve 1 blocked node. Reconstruction failed, so this step did not run.`,
            ),
          }),
          // The summary quotes one reason, which belongs to Histogram and
          // outlier review here, so the row names both blocked stages.
          runtimeRun('two-stages', 'blocked', {
            summary: blockedSummary(
              2,
              `Resolve 2 blocked nodes. ENIGMA QC was blocked, so this step did not run. 1 more reason applies.`,
            ),
          }),
          runtimeRun('metadata', 'blocked', {
            summary: blockedSummary(
              1,
              `Resolve 1 blocked node. ${metadataReason}`,
            ),
          }),
          // One stage blocked for two subjects for different reasons keeps
          // the count of the reasons the row leaves out.
          runtimeRun('two-reasons', 'blocked', {
            summary: blockedSummary(
              2,
              `Resolve 2 blocked nodes. Brain FOV preparation failed, so this step did not run. 1 more reason applies.`,
            ),
          }),
        ]}
      />,
    )

    expect(
      await screen.findByText(
        'ENIGMA QC did not run because Reconstruction failed. 2 subjects',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'ENIGMA QC, Histogram and outlier review blocked 2 subjects',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(`${metadataReason} 2 subjects`)).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show more recent runs.' }),
    )
    expect(
      screen.getByText(
        'Reconstruction did not run because Brain FOV preparation failed. 1 more reason applies. 2 subjects',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Resolve/)).toBeNull()
    expect(screen.queryByText(/this step/)).toBeNull()
  })

  it('states an empty run history as a fact, not an order', async () => {
    // Every empty state states a fact rather than giving orders.
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
    })
    renderProjectDashboard(
      <>
        <ProjectDashboard subjects={makeMockCohort(1, 57)} />
        <RouteProbe />
      </>,
    )

    const empty = await screen.findByText('No runs yet.')
    // The panel states the fact on one line, with no hint below it, and
    // offers the fixing action.
    const state = empty.parentElement as HTMLElement
    expect(state).toHaveTextContent(/^No runs yet\.Open Runs$/)
    expect(screen.queryByText(/Start a pipeline/)).toBeNull()
    expect(screen.queryByText(/durable history/)).toBeNull()
    fireEvent.click(within(state).getByRole('button', { name: 'Open Runs' }))
    expect(screen.getByTestId('route-probe')).toHaveTextContent(/^runs:/)
  })

  it('holds the recent runs empty state until the runtime restore answers', async () => {
    // Until the runtime restore answers the run history is unknown, not empty,
    // so the panel must not read "No runs are recorded yet."
    const list = vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
    })
    const restoring = {
      ...runtimeState({ runs: [], jobs: [] }),
      hydrating: true,
    }
    const view = renderProjectDashboard(
      <RuntimeContext.Provider value={restoring}>
        <ProjectDashboard subjects={makeMockCohort(1, 57)} runtimeRuns={[]} />
      </RuntimeContext.Provider>,
    )

    await waitFor(() => expect(list).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByText('No runs yet.')).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()

    view.rerender(
      <AppProvider>
        <Bootstrap>
          <RuntimeContext.Provider value={runtimeState({ runs: [], jobs: [] })}>
            <ProjectDashboard
              subjects={makeMockCohort(1, 57)}
              runtimeRuns={[]}
            />
          </RuntimeContext.Provider>
        </Bootstrap>
      </AppProvider>,
    )
    expect(await screen.findByText('No runs yet.')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull()
  })

  it('states an unread run history as unknown and keeps Retry', async () => {
    // The error detail states a fact; an order would repeat the Retry button
    // beside it.
    const list = vi
      .spyOn(getApi().manifest, 'list')
      .mockRejectedValue(new Error('manifest unavailable'))
    renderProjectDashboard(
      <ProjectDashboard subjects={makeMockCohort(1, 57)} />,
    )

    expect(
      await screen.findByText('Could not read the run history.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'The run history is unknown, so this panel may not be empty.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Retry before/)).toBeNull()
    const calls = list.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls))
  })

  it('should surface discovery errors and retry project-scoped loading', async () => {
    const api = getApi()
    const discover = vi
      .spyOn(api.subjects, 'discover')
      .mockRejectedValue('discovery unavailable')
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
    })
    renderProjectDashboard(<ProjectDashboard />)

    expect(
      await screen.findByText('Could not load the dashboard.'),
    ).toBeInTheDocument()
    expect(screen.getByText('discovery unavailable')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(discover.mock.calls.length).toBeGreaterThan(1))
  })

  it('should show the total-subjects count when the cohort is provided', async () => {
    const cohort = makeMockCohort(80, 17)
    renderDashboard(<ProjectDashboard subjects={cohort} />)
    const tile = await screen.findByRole('button', {
      name: 'Open all subjects (Subjects: 80).',
    })
    expect(tile).toBeInTheDocument()
  })

  it('should deep-link each stat tile into Subjects pre-filtered to its state', () => {
    const cohort = makeMockCohort(12, 17)
    renderDashboard(
      <>
        <ProjectDashboard subjects={cohort} />
        <RouteProbe />
      </>,
    )
    const probe = screen.getByTestId('route-probe')
    expect(probe).toHaveTextContent(/:all$/)

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Open failed subjects \(Failed: \d+\)\.$/,
      }),
    )
    expect(probe).toHaveTextContent('subjects:failed')

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Open running subjects \(Running: \d+\)\.$/,
      }),
    )
    expect(probe).toHaveTextContent('subjects:running')

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Open pending subjects \(Pending: \d+\)\.$/,
      }),
    )
    expect(probe).toHaveTextContent('subjects:pending')

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Open done subjects \(Done: \d+\)\./,
      }),
    )
    expect(probe).toHaveTextContent('subjects:done')

    // Partly done and Out of date open their own filters, not Pending.
    fireEvent.click(
      screen.getByRole('button', {
        name: /^Open partly done subjects \(Partly done: \d+\)\./,
      }),
    )
    expect(probe).toHaveTextContent('subjects:partial')

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Open out-of-date subjects \(Out of date: \d+\)\./,
      }),
    )
    expect(probe).toHaveTextContent('subjects:outdated')

    fireEvent.click(
      screen.getByRole('button', {
        name: /^Open all subjects \(Subjects: \d+\)\.$/,
      }),
    )
    expect(probe).toHaveTextContent('subjects:all')
  })

  it('should set the active subject and route to QC when a recent row is double-clicked', async () => {
    const cohort = makeMockCohort(80, 17)
    const onActiveSubjectChange = vi.fn()
    renderDashboard(
      <ProjectDashboard
        subjects={cohort}
        onActiveSubjectChange={onActiveSubjectChange}
      />,
    )

    const firstRow = await waitFor(() => {
      const matrix = screen.getByRole('table', {
        name: 'Recent subjects status matrix',
      })
      const openBtn = within(matrix).getAllByRole('button', {
        name: /^Open .* in QC review$/,
      })[0]
      const row = openBtn?.closest('[role="row"]')
      if (!row) throw new Error('Render at least one subject row.')
      return row as HTMLElement
    })

    fireEvent.doubleClick(firstRow)
    expect(onActiveSubjectChange).toHaveBeenCalledTimes(1)
    const id = onActiveSubjectChange.mock.calls[0]?.[0]
    expect(typeof id).toBe('string')
    expect(id).toMatch(/^sub-\d{3}$/)
  })

  it('should name the blocked cohort stage that finished subjects wait on', async () => {
    // A blocked R analysis must not leave 82 finished subjects reading only "In
    // progress 82", with no stage or reason named.
    const reason =
      'Provide the metadata file /tmp/dashboard/metadata/metadata.csv with a ' +
      'subject ID column (participant_id) and a Cohort column; Sex and Age ' +
      'are optional.'
    const finalRun: RunManifest = {
      ...runManifest('run-final', 'done', { subjects: 2 }),
      steps: [
        {
          id: 1,
          key: 'aggregate',
          status: 'done',
          subjects: 2,
          failed: 0,
          durationSec: 10,
        },
        {
          id: 2,
          key: 'final',
          status: 'blocked',
          subjects: 2,
          failed: 0,
          durationSec: 0,
        },
      ],
    }
    vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
      items: [finalRun],
      nextCursor: null,
    })
    renderProjectDashboard(
      <>
        <ProjectDashboard
          subjects={[
            subjectFinishedExceptReport('sub-001'),
            subjectFinishedExceptReport('sub-002'),
          ]}
          runtimeRuns={[
            runtimeRun('run-final', 'blocked', {
              summary: {
                planned: 0,
                started: 10,
                waiting: 0,
                blocked: 1,
                skipped: 0,
                message: `This pass runs 10 nodes; 1 blocked node will not run. ${reason}`,
              },
            }),
          ]}
        />
        <RouteProbe />
      </>,
    )

    const notice = await screen.findByText(
      '2 subjects are waiting on R analysis (blocked).',
    )
    // The short headline is a routine fact in regular weight; its tooltip
    // keeps the full sentence.
    expect(notice).toHaveAttribute(
      'title',
      '2 subjects finished their own stages; waiting on R analysis (blocked).',
    )
    expect(notice.style.fontWeight).toBe('400')
    expect(notice.closest('[role="status"]')).toHaveTextContent(reason)
    // The counting definition stays: Done still needs the Report cell.
    expect(
      screen.getByText(
        'Subjects 2, Done 0, Out of date 0, Partly done 2, Running 0, Failed 0, Pending 0',
      ),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open Runs' }))
    expect(screen.getByTestId('route-probe')).toHaveTextContent(/^runs:/)
  })

  it('should read a cohort job blocked at run time from the runtime projection', () => {
    const reason =
      'Rerun aggregate before final because no matching current provenance receipt exists.'
    const run = runtimeRun('run-final', 'blocked')
    render(
      <AppProvider>
        <RuntimeContext.Provider
          value={runtimeState({
            runs: [run],
            jobs: [
              {
                id: 'job-final',
                runId: 'run-final',
                stepKey: 'final',
                subjectId: null,
                startedAt: null,
                endedAt: Date.parse('2026-07-22T18:06:00.000Z'),
                exitCode: null,
                cmd: '',
                stdoutPath: '',
                stderrPath: '',
                envSnapshotPath: '',
                configSnapshotPath: '',
                status: 'blocked',
                terminalReason: reason,
              },
            ],
          })}
        >
          <ProjectDashboard
            subjects={[subjectFinishedExceptReport('sub-001')]}
          />
        </RuntimeContext.Provider>
      </AppProvider>,
    )

    const notice = screen.getByText(
      '1 subject is waiting on R analysis (blocked).',
    )
    expect(notice).toHaveAttribute(
      'title',
      '1 subject finished its own stages; waiting on R analysis (blocked).',
    )
    // The readiness order reads as its fact.
    expect(notice.closest('[role="status"]')).toHaveTextContent(
      'Structural data aggregation has no current receipt for R analysis.',
    )
    expect(notice.closest('[role="status"]')).not.toHaveTextContent(reason)
  })

  it('should state no failures as a fact beside a success icon, not a warning', () => {
    renderDashboard(
      <ProjectDashboard subjects={[subjectFinishedExceptReport('sub-001')]} />,
    )

    const message = screen.getByText('No subjects need attention.')
    const empty = message.parentElement!
    // The panel states the fact on one line, with no hint below it.
    expect(empty).toHaveTextContent(/^No subjects need attention\.$/)
    // The check mark replaces the warning triangle.
    expect(empty.querySelector('path')).toHaveAttribute('d', 'M20 6 9 17l-5-5')
    expect(screen.queryByText(/Continue because/)).toBeNull()
  })

  it('counts subjects Done and names no waiting stage when PyBrainAge is off', () => {
    // With PyBrainAge, Clinical merge, Brain-PAD statistics, and R analysis off, a
    // Run all finishes every enabled stage, so the subjects count as Done and
    // wait on no stage that is off.
    const cfg = structuredClone(DEFAULT_PROJECT_CONFIG)
    for (const key of [
      'pybrainage',
      'clinical',
      'brainpad',
      'final',
    ] as const) {
      cfg.steps[key] = { ...cfg.steps[key], enabled: false }
    }
    const off = new Set(['pba', 'stats', 'rep'])
    const subjects = ['sub-101', 'sub-901', 'sub-902', 'sub-906'].map((id) => ({
      ...subjectFinishedExceptReport(id),
      cells: MATRIX_STEPS.map((step) => ({
        ...emptyCell(),
        st: off.has(step.key) ? ('pending' as const) : ('done' as const),
        finishedAt: off.has(step.key) ? null : 1,
      })),
    }))

    renderDashboard(<ProjectDashboard cfg={cfg} subjects={subjects} />)

    expect(
      screen.getByRole('button', { name: /^Open done subjects \(Done: 4\)\./ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^Open partly done subjects \(Partly done: 0\)\./,
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/waiting on/)).toBeNull()
    expect(screen.queryByText(/finished (its|their) own stages/)).toBeNull()
    // The stage turned off reads skipped in Recent subjects.
    expect(screen.getAllByLabelText(/^PyBrainAge: skipped/)).toHaveLength(4)
  })

  it('should not name a waiting stage once every subject is done', () => {
    const done = subjectFinishedExceptReport('sub-001')
    done.cells = done.cells.map((cell) => ({ ...cell, st: 'done' }))
    renderDashboard(<ProjectDashboard subjects={[done]} />)

    expect(screen.queryByText(/finished (its|their) own stages/)).toBeNull()
    expect(noticeRunsButtons()).toHaveLength(0)
  })

  describe('cohort stage currency notice', () => {
    const COHORT_STAGES = [
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

    /** A subject whose every matrix cell and cohort stage finished. */
    function finishedSubject(id: string): Subject {
      const subject = subjectFinishedExceptReport(id)
      subject.cells = subject.cells.map((cell) => ({ ...cell, st: 'done' }))
      subject.qc = 'pass'
      subject.stepStates = Object.fromEntries(
        COHORT_STAGES.map((key) => [key, 'done']),
      )
      return subject
    }

    function mockCurrency(
      state: 'current' | 'outdated',
      options: { cause?: boolean; change?: 'membership' | null } = {},
    ): ReturnType<typeof vi.spyOn> {
      vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
        items: [],
        nextCursor: null,
      })
      return vi.spyOn(getApi().results, 'list').mockResolvedValue({
        items: [],
        nextCursor: null,
        truncated: false,
        stageCurrency: {
          recon: { state: 'current', outdatedSubjectIds: [] },
          ...Object.fromEntries(
            COHORT_STAGES.map((key) => [
              key,
              {
                state,
                outdatedSubjectIds: [],
                ...(options.cause ? { cause: 'analysis-cohort' as const } : {}),
              },
            ]),
          ),
        },
        analysisCohortChange:
          options.change === undefined || options.change === null
            ? null
            : { cause: options.change },
      })
    }

    it('names the QC cause when verdicts put the cohort stages out of date', async () => {
      const list = mockCurrency('outdated', {
        cause: true,
        change: 'membership',
      })
      renderProjectDashboard(
        <>
          <ProjectDashboard
            subjects={[finishedSubject('sub-001'), finishedSubject('sub-002')]}
            runtimeRuns={[]}
          />
          <RouteProbe />
        </>,
      )

      const headline = await screen.findByText(
        '9 cohort stages are out of date for 2 subjects: the analysis cohort changed after they ran.',
      )
      const notice = headline.closest('[role="status"]')
      expect(notice).toHaveTextContent(
        'Run all reruns ENIGMA QC, Histogram and outlier review, FreeSurfer feature extraction, Age metadata integration, PyBrainAge prediction, Clinical merge, Brain-PAD statistics, Structural data aggregation, and R analysis.',
      )
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ project: DASHBOARD_PROJECT, limit: 1 }),
      )
      // Only out-of-date cohort cells are left, so both subjects count Out of
      // date: not Done, and not Partly done while nothing runs.
      expect(
        screen.getByText(
          'Subjects 2, Done 0, Out of date 2, Partly done 0, Running 0, Failed 0, Pending 0',
        ),
      ).toBeInTheDocument()

      fireEvent.click(
        within(notice as HTMLElement).getByRole('button', {
          name: 'Open Runs',
        }),
      )
      expect(screen.getByTestId('route-probe')).toHaveTextContent(/^runs:/)
    })

    it('marks Recent subjects cells out of date and shows one notice', async () => {
      mockCurrency('outdated', { cause: true, change: 'membership' })
      renderProjectDashboard(
        <ProjectDashboard
          subjects={[finishedSubject('sub-001'), finishedSubject('sub-002')]}
          runtimeRuns={[]}
        />,
      )

      await screen.findByText(/9 cohort stages are out of date/)
      const matrix = screen.getByRole('table', {
        name: 'Recent subjects status matrix',
      })
      for (const step of [
        'Subcortical QC',
        'Internal cortical QC',
        'External cortical QC',
        'Feature extraction',
        'PyBrainAge',
        'Statistics',
        'Aggregation',
        'Report',
      ]) {
        expect(
          within(matrix).getAllByRole('img', { name: `${step}: out of date` }),
        ).toHaveLength(2)
      }
      expect(
        within(matrix).getAllByRole('img', { name: 'Reconstruction: done' }),
      ).toHaveLength(2)
      expect(
        screen.getByRole('button', { name: /^Open done subjects \(Done: 0\)/ }),
      ).toBeInTheDocument()
      // The tile hint states what the bucket holds rather than giving an order.
      expect(
        screen.getByRole('button', {
          name: /^Open out-of-date subjects \(Out of date: 2\)/,
        }),
      ).toHaveAccessibleName(
        'Open out-of-date subjects (Out of date: 2). Every step finished for these subjects, and at least one step is out of date. Run all reruns the out-of-date steps.',
      )
      // The currency notice stands alone: no subject waits on a cohort stage.
      expect(noticeRunsButtons()).toHaveLength(1)
      expect(screen.queryByText(/finished (its|their) own stages/)).toBeNull()
    })

    it('states on the Out of date tile the subjects another tile counts', async () => {
      // After a canceled run the notice counts out-of-date stages for subjects
      // that the Canceled tile holds, since each subject counts in one tile and
      // Canceled ranks first; the Out of date tile says so.
      mockCurrency('outdated', { cause: true, change: 'membership' })
      const canceled = finishedSubject('sub-002')
      canceled.cells = canceled.cells.map((cell, index) =>
        index === 0 ? { ...cell, st: 'cancelled' } : cell,
      )
      renderProjectDashboard(
        <ProjectDashboard
          subjects={[finishedSubject('sub-001'), canceled]}
          runtimeRuns={[]}
        />,
      )

      await screen.findByText(/cohort stages are out of date for 2 subjects/)
      const tile = screen.getByRole('button', {
        name: /^Open out-of-date subjects \(Out of date: 1\)/,
      })
      expect(tile).toHaveAccessibleName(
        'Open out-of-date subjects (Out of date: 1). Every step finished for these subjects, and at least one step is out of date. Run all reruns the out-of-date steps. 1 subject with an out-of-date step is counted under Canceled, since each subject counts in one tile.',
      )
      expect(within(tile).getByText('1 under Canceled')).toBeVisible()
      expect(
        screen.getByRole('button', {
          name: /^Open canceled subjects \(Canceled: 1\)/,
        }),
      ).toBeInTheDocument()
      // A tile no other bucket takes from carries no note.
      expect(
        within(
          screen.getByRole('button', { name: /^Open done subjects/ }),
        ).queryByText(/ in /),
      ).toBeNull()
    })

    it('states the notice subjects another tile counts when no cell is out of date', async () => {
      // After a run canceled during ENIGMA QC, Histogram and outlier review (no
      // matrix column) and Age metadata integration (its Feat cell canceled)
      // stay out of date while no cell reads out of date. A canceled cohort
      // stage is a cohort fact, so the subjects read Partly done, not Canceled.
      vi.spyOn(getApi().manifest, 'list').mockResolvedValue({
        items: [],
        nextCursor: null,
      })
      vi.spyOn(getApi().results, 'list').mockResolvedValue({
        items: [],
        nextCursor: null,
        truncated: false,
        stageCurrency: {
          recon: { state: 'current', outdatedSubjectIds: [] },
          ...Object.fromEntries(
            COHORT_STAGES.map((key) => [
              key,
              {
                state:
                  key === 'outliers' || key === 'age' ? 'outdated' : 'current',
                outdatedSubjectIds: [],
              },
            ]),
          ),
        },
        analysisCohortChange: null,
      })
      const canceledSubject = (id: string): Subject => {
        const subject = finishedSubject(id)
        const canceledColumns = new Set(['qcsub', 'qcic', 'qcec', 'feat'])
        subject.cells = subject.cells.map((cell, index) =>
          canceledColumns.has(MATRIX_STEPS[index]?.key ?? '')
            ? { ...cell, st: 'cancelled' }
            : cell,
        )
        subject.stepStates = {
          ...subject.stepStates,
          enigma: 'cancelled',
          features: 'cancelled',
        }
        return subject
      }
      renderProjectDashboard(
        <ProjectDashboard
          subjects={[canceledSubject('sub-001'), canceledSubject('sub-002')]}
          runtimeRuns={[]}
        />,
      )

      await screen.findByText(/2 cohort stages are out of date for 2 subjects/)
      const tile = screen.getByRole('button', {
        name: /^Open out-of-date subjects \(Out of date: 0\)/,
      })
      expect(tile).toHaveAccessibleName(
        expect.stringMatching(
          /2 subjects with an out-of-date step are counted under Partly done, since each subject counts in one tile\.$/,
        ),
      )
      expect(within(tile).getByText('2 under Partly done')).toBeVisible()
    })

    it('counts subjects by their own work when a cohort stage failed', async () => {
      // A Run all failed at R analysis alone, and two subjects were added
      // after it. No subject's own work failed, so none counts as Failed; the
      // notices state the failed cohort stage once.
      mockCurrency('outdated', { cause: true })
      const finalFailed = (id: string): Subject => {
        const subject = finishedSubject(id)
        subject.cells = subject.cells.map((cell, index) =>
          MATRIX_STEPS[index]?.key === 'rep'
            ? { ...cell, st: 'failed', rc: 1, err: 'R analysis failed.' }
            : cell,
        )
        subject.stepStates = { ...subject.stepStates, final: 'failed' }
        return subject
      }
      const added = subjectFinishedExceptReport('sub-new')
      added.cells = added.cells.map((cell) => ({
        ...cell,
        st: 'pending',
        finishedAt: null,
      }))
      renderProjectDashboard(
        <ProjectDashboard
          subjects={[finalFailed('sub-001'), finalFailed('sub-002'), added]}
          runtimeRuns={[]}
        />,
      )

      await screen.findByText(/8 cohort stages are out of date for 2 subjects/)
      expect(
        screen.getByText(
          'Subjects 3, Done 0, Out of date 0, Partly done 2, Running 0, Failed 0, Pending 1',
        ),
      ).toBeInTheDocument()
      expect(
        screen.getByText(/R analysis failed; Run all reruns it too\./),
      ).toBeInTheDocument()
      expect(
        within(
          screen.getByRole('button', {
            name: /^Open out-of-date subjects \(Out of date: 0\)/,
          }),
        ).getByText('2 under Partly done'),
      ).toBeVisible()
      // The Report cells still show the failure.
      const matrix = screen.getByRole('table', {
        name: 'Recent subjects status matrix',
      })
      expect(
        within(matrix).getAllByRole('img', { name: 'Report: failed' }),
      ).toHaveLength(2)
      // No subject needs attention for its own work.
      expect(screen.queryByText(/^\d+ failed$/)).toBeNull()
      expect(
        screen
          .queryAllByRole('button', { name: /^Open sub-\d+ in QC review$/ })
          .filter((button) => !matrix.contains(button)),
      ).toHaveLength(0)
    })

    it('shows no notice while every cohort stage is current', async () => {
      const list = mockCurrency('current')
      renderProjectDashboard(
        <ProjectDashboard
          subjects={[finishedSubject('sub-001')]}
          runtimeRuns={[]}
        />,
      )

      await waitFor(() => expect(list).toHaveBeenCalled())
      expect(screen.queryByText(/out of date/)).toBeNull()
      expect(noticeRunsButtons()).toHaveLength(0)
    })

    it('does not call a cohort stage that never ran out of date', async () => {
      // With no receipt anywhere the planner runs a stage too; that is not
      // run yet, not out of date.
      const list = mockCurrency('outdated')
      const subject = finishedSubject('sub-001')
      subject.stepStates = {}
      renderProjectDashboard(
        <ProjectDashboard subjects={[subject]} runtimeRuns={[]} />,
      )

      await waitFor(() => expect(list).toHaveBeenCalled())
      expect(screen.queryByText(/out of date/)).toBeNull()
    })
  })
})
