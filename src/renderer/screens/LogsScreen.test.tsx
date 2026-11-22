// @vitest-environment jsdom

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
import type {
  DebugBundlePreview,
  ProjectOpenResult,
  RunSnapshot,
  RuntimeEvent,
  RuntimeSnapshot,
  SupraspinaApi,
  WorkflowResult,
  WorkflowSummary,
} from '../../shared/contract'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import { PlanStaleError } from '../../shared/rpc-errors'
import type { Job, RunManifest } from '../../shared/types'
import { createMockApi } from '../ipc/mock'
import { AppProvider, useApp } from '../state/context'
import { runTimestampLabel } from '../state/run-label'
import { RuntimeProvider } from '../state/runtime-context'
import { WorkflowReviewProvider } from '../state/workflow-review'
import { WorkflowReviewContext } from '../state/workflow-review-state'
import { formatRunTime, statusGlyphColor, statusGlyphShape } from '../ui/status'
import { TEXT_GAP } from '../ui/text-gap'
import { highContrastTheme, THEMES } from '../theme/tokens'
import { LogsScreen, type LogsScreenProps } from './LogsScreen'
import { ProjectDashboard } from './ProjectDashboard'

function Bootstrap({
  result,
  children,
}: {
  result: ProjectOpenResult
  children: ReactNode
}): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (!booted.current) {
      booted.current = true
      app.markProjectCreated(result)
    }
  }, [app, result])
  return children
}

function RouteProbe(): ReactNode {
  const { route } = useApp()
  return <output data-testid="route-probe">{route}</output>
}

/**
 * The Run list's short start time: no seconds, and no year for a run that
 * started this year.
 */
function runListTime(ms: number): string {
  const date = new Date(ms)
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(date.getFullYear() === new Date().getFullYear()
      ? {}
      : { year: 'numeric' as const }),
  }).format(date)
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    runId: 'run-1',
    nodeId: 'node-1',
    projectId: 'unused',
    projectEpoch: 1,
    stepKey: 'recon',
    subjectId: 'sub-001',
    startedAt: 100,
    endedAt: 200,
    exitCode: 1,
    cmd: 'recon-all -s sub-001',
    stdoutPath: '',
    stderrPath: '',
    envSnapshotPath: '',
    configSnapshotPath: '',
    status: 'failed',
    durable: true,
    ...overrides,
  }
}

async function renderScreen(
  snapshotFactory: (
    project: ProjectOpenResult['project'],
  ) => RuntimeSnapshot | Promise<RuntimeSnapshot>,
  api: SupraspinaApi = createMockApi(),
  props: LogsScreenProps = {},
  approveWorkflowReview = false,
): Promise<{
  api: SupraspinaApi
  result: ProjectOpenResult
  view: ReturnType<typeof render>
}> {
  window.supraspina = api
  const cfg = {
    ...DEFAULT_PROJECT_CONFIG,
    paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/projects/logs' },
  }
  const result = await api.project.create({
    at: '/projects/logs',
    cfg,
    epoch: 1,
  })
  vi.spyOn(api.runtime, 'bootstrap').mockImplementation(async () =>
    snapshotFactory(result.project),
  )
  const view = render(
    <AppProvider>
      <Bootstrap result={result}>
        <WorkflowReviewContext.Provider
          value={
            approveWorkflowReview
              ? { review: async () => true, inspect: async () => undefined }
              : null
          }
        >
          <RuntimeProvider>
            <LogsScreen {...props} />
            <RouteProbe />
          </RuntimeProvider>
        </WorkflowReviewContext.Provider>
      </Bootstrap>
    </AppProvider>,
  )
  return { api, result, view }
}

function run(
  project: ProjectOpenResult['project'],
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  return {
    runId: 'run-1',
    projectId: project.projectId,
    projectEpoch: project.epoch,
    status: 'failed',
    startedAt: 100,
    endedAt: 200,
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
    ...overrides,
  }
}

function snapshot(
  project: ProjectOpenResult['project'],
  jobs: Job[] = [],
  overrides: Omit<Partial<RuntimeSnapshot>, 'project'> = {},
): RuntimeSnapshot {
  const scopedJobs = jobs.map((item) => ({
    ...item,
    projectId: project.projectId,
    projectEpoch: project.epoch,
    sidecarGeneration: 1,
  }))
  const runIds = [
    ...new Set(
      scopedJobs
        .map((item) => item.runId)
        .filter((runId): runId is string => Boolean(runId)),
    ),
  ]
  return {
    project,
    sidecarGeneration: 1,
    sequence: 4,
    runs: runIds.map((runId) =>
      run(project, {
        runId,
        status:
          scopedJobs.find((item) => item.runId === runId)?.status ?? 'failed',
      }),
    ),
    jobs: scopedJobs,
    logTail: jobs.length
      ? [
          {
            id: 'log-1',
            runId: 'run-1',
            jobId: jobs[0]?.id ?? 'job-1',
            at: 150,
            level: 'ERROR',
            line: 'backend failure',
          },
        ]
      : [],
    provision: null,
    ...overrides,
  }
}

function preview(
  overrides: Partial<DebugBundlePreview> = {},
): DebugBundlePreview {
  return {
    runId: 'run-1',
    categories: [],
    totalFiles: 0,
    estimatedBytes: 0,
    redactionPolicy: 'Keep subject identifiers redacted.',
    truncated: false,
    ...overrides,
  }
}

function blockedNormalizationOutcome(): WorkflowResult {
  const summary: WorkflowSummary = {
    planned: 0,
    started: 0,
    waiting: 0,
    blocked: 1,
    skipped: 0,
    message:
      'Normalize the reconstruction cohort before starting downstream work because its current backends differ.',
  }
  return {
    runId: null,
    disposition: 'blocked',
    plan: {
      planId: 'normalize-blocked',
      analysisCohort: { subjectIds: ['sub-001'], sha256: 'analysis' },
      selectedSubset: { subjectIds: ['sub-001'], sha256: 'selected' },
      nodes: [],
      blockers: [
        {
          key: 'features',
          kind: 'cohort',
          reason: summary.message,
          action: 'normalize-reconstruction-cohort',
        },
      ],
      summary,
    },
    summary,
  }
}

function blockedRegistryOutcome(): WorkflowResult {
  const summary: WorkflowSummary = {
    planned: 0,
    started: 0,
    waiting: 0,
    blocked: 1,
    skipped: 0,
    message: 'Resolve 1 blocked node before retrying this workflow.',
  }
  return {
    runId: null,
    disposition: 'blocked',
    plan: {
      planId: 'registry-blocked',
      analysisCohort: { subjectIds: ['sub-001'], sha256: 'analysis' },
      selectedSubset: { subjectIds: ['sub-001'], sha256: 'selected' },
      nodes: [],
      blockers: [
        {
          key: 'recon',
          kind: 'cohort',
          reason:
            'Register every subject before retrying because sub-001 is unregistered.',
          action: 'open-registry',
          subjects: ['sub-001'],
        },
      ],
      summary,
    },
    summary,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function renderWithoutProject(
  api: SupraspinaApi = createMockApi(),
): ReturnType<typeof render> {
  window.supraspina = api
  return render(
    <AppProvider>
      <RuntimeProvider>
        <LogsScreen />
      </RuntimeProvider>
    </AppProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.supraspina
})

/**
 * Match the innermost element whose whole text is `text`, for a line that
 * sets an ID or path in inline code beside prose.
 */
function fullText(
  text: string,
): (content: string, element: Element | null) => boolean {
  return (_content, element) =>
    element?.textContent === text &&
    Array.from(element.children).every((child) => child.textContent !== text)
}

describe('LogsScreen runtime projection', () => {
  it('keeps the selected job command block keyboard reachable', async () => {
    // The block scrolls its overflow, so it needs a tab stop and a name.
    await renderScreen((project) => snapshot(project, [job()]))

    const command = await screen.findByLabelText('Job command')
    expect(command).toHaveAttribute('tabindex', '0')
    expect(command).toHaveTextContent('recon-all -s sub-001')
    expect(command).toHaveStyle({ overflow: 'auto' })
  })

  it('wraps the selected job command only between its tokens', async () => {
    // A hyphen is a line-break opportunity, so a bare pre-wrap block split
    // "-openmp" and "sub-001" across lines.
    const cmd = 'recon-all -s sub-001 -all -parallel -openmp 6'
    await renderScreen((project) => snapshot(project, [job({ cmd })]))

    const command = await screen.findByLabelText('Job command')
    expect(command.textContent).toBe(cmd)
    expect(command).toHaveStyle({ whiteSpace: 'pre-wrap' })
    const tokens = [...command.querySelectorAll('span')]
    expect(tokens.map((token) => token.textContent)).toEqual(cmd.split(' '))
    for (const token of tokens) {
      expect(token).toHaveStyle({ whiteSpace: 'nowrap' })
    }
  })

  it('keeps project-bound controls inert when no project is open', async () => {
    const api = createMockApi()
    const bootstrap = vi.spyOn(api.runtime, 'bootstrap')
    renderWithoutProject(api)

    expect(
      await screen.findByText('No durable job exists yet.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Refresh run manifest' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Export debug bundle...' }),
    ).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
    expect(
      screen.getByText('No job with a durable run identity is selected.'),
    ).toBeInTheDocument()
    expect(bootstrap).not.toHaveBeenCalled()
  })

  it('shows hydration progress and preserves a runtime bootstrap failure', async () => {
    const pending = deferred<RuntimeSnapshot>()
    await renderScreen(() => pending.promise)

    expect(
      await screen.findByText('Restoring runtime logs...'),
    ).toBeInTheDocument()
    await act(async () => {
      pending.reject(new Error('runtime database offline'))
      await Promise.resolve()
    })

    expect(
      await screen.findByText('Could not recover runtime state.'),
    ).toBeInTheDocument()
    expect(screen.getByText('runtime database offline')).toBeInTheDocument()
    expect(
      screen.queryByText('Restoring runtime logs...'),
    ).not.toBeInTheDocument()
  })

  it('retries the runtime restore from the restore error', async () => {
    // Without a Retry the restore error would stay until a reload.
    let attempts = 0
    await renderScreen((project) => {
      attempts += 1
      if (attempts === 1) throw new Error('runtime database offline')
      return snapshot(project)
    })

    const title = await screen.findByText('Could not recover runtime state.')
    const alert = title.closest('[role="alert"]') as HTMLElement
    expect(alert).not.toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: /^Retry/ }))
    await waitFor(() =>
      expect(
        screen.queryByText('Could not recover runtime state.'),
      ).not.toBeInTheDocument(),
    )
    expect(attempts).toBe(2)
    expect(
      await screen.findByText('No durable job exists yet.'),
    ).toBeInTheDocument()
  })

  it('shows honest empty history and never subscribes to route-local streams', async () => {
    const api = createMockApi()
    const jobs = vi.spyOn(api.pipeline, 'onJobUpdate')
    const stdout = vi.spyOn(api.pipeline, 'onStdout')
    const directRun = vi.spyOn(api.pipeline, 'runWorkflow')
    await renderScreen((project) => snapshot(project), api)

    expect(
      await screen.findByText('No durable job exists yet.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/#0991|exit 137/)).not.toBeInTheDocument()
    expect(jobs).not.toHaveBeenCalled()
    expect(stdout).not.toHaveBeenCalled()
    expect(directRun).not.toHaveBeenCalled()
  })

  it('hydrates durable jobs and logs from the single runtime store', async () => {
    await renderScreen((project) =>
      snapshot(project, [job({ status: 'blocked' })]),
    )
    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    expect(within(rail).getByText('Blocked')).toBeInTheDocument()
    expect(
      await within(rail).findByText(
        /Jobs this run did not start because an upstream stage is missing, failed, or withheld/,
      ),
    ).toBeInTheDocument()
    expect(await screen.findByText('backend failure')).toBeInTheDocument()
  })

  it('keeps each log line clock on one line in a gutter sized for it', async () => {
    await renderScreen((project) => snapshot(project, [job()]))
    const clock = await screen.findByTestId('log-line-clock')
    expect(clock).toHaveStyle({ whiteSpace: 'nowrap' })
    expect(clock.parentElement).toHaveStyle({
      gridTemplateColumns: '12ch 40px minmax(0, 1fr)',
    })
  })

  it('defaults to all jobs and changes scope only through the explicit control', async () => {
    await renderScreen((project) =>
      snapshot(project, [job(), job({ id: 'job-2', subjectId: 'sub-002' })], {
        logTail: [
          {
            id: 'log-1',
            runId: 'run-1',
            jobId: 'job-1',
            at: 100,
            level: 'INFO',
            line: 'first job progress',
          },
          {
            id: 'log-2',
            runId: 'run-1',
            jobId: 'job-2',
            at: 110,
            level: 'INFO',
            line: 'second job progress',
          },
        ],
      }),
    )

    expect(await screen.findByText('first job progress')).toBeInTheDocument()
    expect(screen.getByText('second job progress')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'All jobs' })).toBeChecked()
    // The counter stays silent while every retained line shows.
    expect(
      screen.getByRole('status', {
        name: 'Showing 2 of 2 retained log lines',
      }),
    ).toHaveTextContent(/^$/)
    expect(screen.getByText('2 lines, Info and above')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Selected job' }))

    expect(screen.getByText('first job progress')).toBeInTheDocument()
    expect(screen.queryByText('second job progress')).not.toBeInTheDocument()
    expect(
      screen.getByRole('status', {
        name: 'Showing 1 of 2 retained log lines',
      }),
    ).toHaveTextContent(/^1 of 2 lines$/)
    expect(screen.getByText('1 line, Info and above')).toBeInTheDocument()

    const rail = screen.getByRole('complementary', { name: 'Jobs' })
    fireEvent.click(within(rail).getByRole('button', { name: /sub-002/i }))
    expect(screen.queryByText('first job progress')).not.toBeInTheDocument()
    expect(screen.getByText('second job progress')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'All jobs' }))
    expect(screen.getByText('first job progress')).toBeInTheDocument()
    expect(screen.getByText('second job progress')).toBeInTheDocument()
  })

  it('keeps a superseded run out of the dry-run, attention, and blocked groups', async () => {
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-current',
            runId: 'run-current',
            status: 'running',
            subjectId: 'sub-current',
            endedAt: null,
            exitCode: null,
          }),
          job({
            id: 'job-old-plan',
            runId: 'run-old',
            status: 'planned',
            dryRun: true,
            subjectId: 'sub-old-plan',
          }),
          job({
            id: 'job-old-failure',
            runId: 'run-old',
            subjectId: 'sub-old-failure',
          }),
          job({
            id: 'job-old-done',
            runId: 'run-old',
            status: 'done',
            subjectId: 'sub-old-done',
          }),
          job({
            id: 'job-old-blocked',
            runId: 'run-old',
            status: 'blocked',
            subjectId: 'sub-old-blocked',
          }),
        ],
        {
          runs: [
            run(project, { runId: 'run-old', startedAt: 100, endedAt: 200 }),
            run(project, {
              runId: 'run-current',
              status: 'running',
              startedAt: 900,
              endedAt: null,
            }),
          ],
          logTail: [],
        },
      ),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    expect(
      await within(rail).findByRole('button', { name: /sub-current/i }),
    ).toBeInTheDocument()
    expect(within(rail).getByText('Active')).toBeInTheDocument()
    expect(within(rail).queryByText('Dry-run plans')).toBeNull()
    expect(within(rail).queryByText('Needs attention')).toBeNull()
    expect(within(rail).queryByText('Blocked')).toBeNull()
    expect(
      within(rail).queryByRole('button', { name: /sub-old-blocked/i }),
    ).toBeNull()
    expect(
      within(rail).queryByRole('button', { name: /sub-old-plan/i }),
    ).toBeNull()
    expect(
      within(rail).queryByRole('button', { name: /sub-old-failure/i }),
    ).toBeNull()

    fireEvent.click(within(rail).getByRole('button', { name: /sub-old-done/i }))

    expect(within(rail).getByText('Dry-run plans')).toBeInTheDocument()
    expect(
      within(rail).getByRole('button', { name: /sub-old-plan/i }),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole('button', { name: /sub-old-failure/i }),
    ).toBeInTheDocument()
  })

  it('reaches the failed and blocked jobs of a run that has no done job', async () => {
    const reason =
      'An unexpected error (RuntimeError) ended the job. Process ownership was not accepted before the timeout.'
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-current-done',
            runId: 'run-current',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-current',
            startedAt: 1_000,
            endedAt: 1_100,
          }),
          job({
            id: 'job-old-failure',
            runId: 'run-old',
            subjectId: 'sub-old-failure',
            exitCode: 127,
            terminalReason: reason,
            startedAt: 100,
            endedAt: 200,
          }),
          job({
            id: 'job-old-blocked',
            runId: 'run-old',
            status: 'blocked',
            stepKey: 'enigma',
            subjectId: null,
            startedAt: null,
            endedAt: 210,
            exitCode: null,
          }),
        ],
        {
          runs: [
            run(project, {
              runId: 'run-old',
              dryRun: false,
              startedAt: 100,
              endedAt: 210,
            }),
            run(project, {
              runId: 'run-current',
              status: 'done',
              dryRun: false,
              startedAt: 1_000,
              endedAt: 1_100,
            }),
          ],
          logTail: [],
        },
      ),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    expect(picker).toHaveValue('run-current')
    expect(picker).toHaveAccessibleDescription(
      'Dry-run plans, Needs attention, and Blocked list the jobs of this run. Choosing a run selects its first job in the list.',
    )
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      `${runListTime(1_000)}${TEXT_GAP}Done`,
      `${runListTime(100)}${TEXT_GAP}Failed`,
    ])
    // No done job of the older run exists to click, so the rail alone has no
    // path to its failures.
    expect(within(rail).queryByText('Needs attention')).toBeNull()
    expect(
      within(rail).queryByRole('button', { name: /sub-old-failure/i }),
    ).toBeNull()

    fireEvent.change(picker, { target: { value: 'run-old' } })

    expect(picker).toHaveValue('run-old')
    expect(within(rail).getByText('Needs attention')).toBeInTheDocument()
    expect(
      within(rail).getByText(/^Jobs this run did not start because/),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole('button', { name: /sub-old-failure/i }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(rail).getByRole('button', { name: /cohort, ENIGMA QC, blocked/i }),
    ).toBeInTheDocument()
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    expect(
      within(controls).getByText(fullText('sub-old-failure / Reconstruction')),
    ).toBeInTheDocument()
    expect(within(controls).getByText(reason)).toBeInTheDocument()
  })

  it('opens on the newest run and moves the run in focus with the selected job', async () => {
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-new-done',
            runId: 'run-new',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-new',
            startedAt: 1_000,
            endedAt: 1_100,
          }),
          job({
            id: 'job-old-done',
            runId: 'run-old',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-old-done',
            startedAt: 100,
            endedAt: 150,
          }),
          job({
            id: 'job-old-failure',
            runId: 'run-old',
            subjectId: 'sub-old-failure',
            startedAt: 160,
            endedAt: 200,
          }),
        ],
        {
          runs: [
            // A run whose jobs the snapshot no longer retains has nothing to
            // list, so the picker leaves it out.
            run(project, {
              runId: 'run-pruned',
              dryRun: false,
              startedAt: 10,
              endedAt: 20,
            }),
            run(project, {
              runId: 'run-old',
              dryRun: false,
              startedAt: 100,
              endedAt: 200,
            }),
            run(project, {
              runId: 'run-new',
              status: 'done',
              dryRun: false,
              startedAt: 1_000,
              endedAt: 1_100,
            }),
          ],
          logTail: [],
        },
      ),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    expect(picker).toHaveValue('run-new')
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(['run-new', 'run-old'])
    expect(
      within(rail).queryByRole('button', { name: /sub-old-failure/i }),
    ).toBeNull()

    fireEvent.click(within(rail).getByRole('button', { name: /sub-old-done/i }))

    expect(picker).toHaveValue('run-old')
    expect(
      within(rail).getByRole('button', { name: /sub-old-failure/i }),
    ).toBeInTheDocument()
  })

  it('streams only the lines of the run in focus under All jobs', async () => {
    // With an older run chosen in the Run list, All jobs must not stream the
    // lines of later runs.
    const line = (
      id: string,
      runId: string,
      jobId: string,
      at: number,
      text: string,
    ) => ({ id, runId, jobId, at, level: 'INFO' as const, line: text })
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-old',
            runId: 'run-old',
            subjectId: 'sub-old',
            startedAt: 100,
            endedAt: 200,
          }),
          job({
            id: 'job-new',
            runId: 'run-new',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-new',
            startedAt: 1_000,
            endedAt: 1_100,
          }),
        ],
        {
          runs: [
            run(project, {
              runId: 'run-old',
              dryRun: false,
              startedAt: 100,
              endedAt: 200,
            }),
            run(project, {
              runId: 'run-new',
              status: 'done',
              dryRun: false,
              startedAt: 1_000,
              endedAt: 1_100,
            }),
          ],
          logTail: [
            line('log-old', 'run-old', 'job-old', 150, 'older run line'),
            line('log-new', 'run-new', 'job-new', 1_050, 'newer run line'),
            line('log-free', '', 'job-gone', 1_060, 'unattributed line'),
          ],
        },
      ),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    const stream = screen.getByTestId('log-stream')
    expect(picker).toHaveValue('run-new')
    expect(await within(stream).findByText('newer run line')).toBeVisible()
    // A line with no run identity belongs to no other run, so it stays.
    expect(within(stream).getByText('unattributed line')).toBeVisible()
    expect(within(stream).queryByText('older run line')).toBeNull()

    fireEvent.change(picker, { target: { value: 'run-old' } })
    expect(await within(stream).findByText('older run line')).toBeVisible()
    expect(within(stream).queryByText('newer run line')).toBeNull()
    expect(screen.getByText('2 lines, Info and above')).toBeInTheDocument()
    expect(screen.queryByText(/^scope:/)).toBeNull()
  })

  it('states that the run in focus has no line in the retained tail', async () => {
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({ id: 'job-old', runId: 'run-old', subjectId: 'sub-old' }),
          job({
            id: 'job-new',
            runId: 'run-new',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-new',
            startedAt: 1_000,
            endedAt: 1_100,
          }),
        ],
        {
          runs: [
            run(project, { runId: 'run-old', dryRun: false }),
            run(project, {
              runId: 'run-new',
              status: 'done',
              dryRun: false,
              startedAt: 1_000,
              endedAt: 1_100,
            }),
          ],
          logTail: [
            {
              id: 'log-old',
              runId: 'run-old',
              jobId: 'job-old',
              at: 150,
              level: 'INFO',
              line: 'older run line',
            },
          ],
        },
      ),
    )
    const stream = await screen.findByTestId('log-stream')
    expect(
      await within(stream).findByText(
        'No lines from this run are in the retained log tail.',
      ),
    ).toBeVisible()
    expect(
      within(stream).getByText(
        'The tail keeps only the newest 1 line across all runs. Choose another run in the Run list to see its lines. The complete job logs remain in backend-owned storage.',
      ),
    ).toBeVisible()
  })

  it('focuses the run of a running job of an older run by default', async () => {
    // While a job of an older run runs, the Run list, the rail, Selected job,
    // and Run details must all follow that job's run, not the newest run.
    const api = createMockApi()
    const forRun = vi.spyOn(api.manifest, 'forRun')
    await renderScreen(
      (project) =>
        snapshot(
          project,
          [
            job({
              id: 'job-running',
              runId: 'run-running',
              status: 'running',
              subjectId: 'sub-003',
              startedAt: 500,
              endedAt: null,
              exitCode: null,
            }),
            job({
              id: 'job-running-failed',
              runId: 'run-running',
              status: 'failed',
              subjectId: 'sub-004',
              startedAt: 400,
              endedAt: 450,
            }),
            job({
              id: 'job-newer-blocked',
              runId: 'run-newer',
              status: 'blocked',
              stepKey: 'final',
              subjectId: null,
              startedAt: null,
              endedAt: 1_100,
              exitCode: null,
            }),
          ],
          {
            runs: [
              run(project, {
                runId: 'run-running',
                status: 'running',
                dryRun: false,
                startedAt: 300,
                endedAt: null,
              }),
              run(project, {
                runId: 'run-newer',
                status: 'blocked',
                dryRun: false,
                startedAt: 1_000,
                endedAt: 1_100,
              }),
            ],
            logTail: [],
          },
        ),
      api,
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    // The picker, Selected job, and Run details name one run.
    expect(picker).toHaveValue('run-running')
    expect(
      within(rail).getByRole('button', { name: /^sub-003,/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(controls).getByText(fullText('sub-003 / Reconstruction')),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(forRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ runId: 'run-running' }),
      ),
    )
    // The rail's run-scoped groups follow that run too.
    expect(
      within(rail).getByRole('button', { name: /^sub-004,/ }),
    ).toBeInTheDocument()
    expect(
      within(rail).queryByRole('button', { name: /R analysis/ }),
    ).toBeNull()

    // Choosing the newer run still moves all three.
    fireEvent.change(picker, { target: { value: 'run-newer' } })
    expect(picker).toHaveValue('run-newer')
    expect(
      within(rail).getByRole('button', { name: /R analysis/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() =>
      expect(forRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ runId: 'run-newer' }),
      ),
    )
  })

  it('lists a chosen failed run beside the running and queued jobs of an older run', async () => {
    // The documentation fixture: Logs opens on the running job's run, which
    // has no failure, so the Logs capture chooses the newer failed run to show
    // Failed and Blocked beside the Running, Queued, and Done rows.
    const api = createMockApi()
    const forRun = vi.spyOn(api.manifest, 'forRun')
    await renderScreen(
      (project) =>
        snapshot(
          project,
          [
            job({
              id: 'job-done',
              runId: 'run-done',
              status: 'done',
              subjectId: 'sub-001',
              exitCode: 0,
              startedAt: 110,
              endedAt: 130,
            }),
            job({
              id: 'job-running',
              runId: 'run-running',
              status: 'running',
              subjectId: 'sub-003',
              startedAt: 220,
              endedAt: null,
              exitCode: null,
            }),
            job({
              id: 'job-queued',
              runId: 'run-running',
              status: 'queued',
              stepKey: 'brainfov',
              subjectId: 'sub-004',
              startedAt: null,
              plannedAt: 230,
              endedAt: null,
              exitCode: null,
            }),
            job({
              id: 'job-other-blocked',
              runId: 'run-blocked',
              status: 'blocked',
              stepKey: 'final',
              subjectId: null,
              startedAt: null,
              endedAt: 330,
              exitCode: null,
            }),
            job({
              id: 'job-failed',
              runId: 'run-failed',
              status: 'failed',
              subjectId: 'sub-002',
              startedAt: 410,
              endedAt: 430,
            }),
            job({
              id: 'job-dependency-blocked',
              runId: 'run-failed',
              status: 'blocked',
              stepKey: 'enigma',
              subjectId: null,
              startedAt: null,
              endedAt: 440,
              exitCode: null,
            }),
          ],
          {
            runs: [
              run(project, {
                runId: 'run-done',
                status: 'done',
                dryRun: false,
                startedAt: 100,
                endedAt: 130,
              }),
              run(project, {
                runId: 'run-running',
                status: 'running',
                dryRun: false,
                startedAt: 200,
                endedAt: null,
              }),
              run(project, {
                runId: 'run-blocked',
                status: 'blocked',
                dryRun: false,
                startedAt: 300,
                endedAt: 330,
              }),
              run(project, {
                runId: 'run-failed',
                status: 'failed',
                dryRun: false,
                startedAt: 400,
                endedAt: 440,
              }),
            ],
            logTail: [],
          },
        ),
      api,
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    expect(picker).toHaveValue('run-running')
    expect(within(rail).queryByRole('button', { name: /^sub-002,/ })).toBeNull()
    expect(within(rail).queryByRole('button', { name: /ENIGMA QC/ })).toBeNull()

    fireEvent.change(picker, { target: { value: 'run-failed' } })
    expect(picker).toHaveValue('run-failed')
    expect(
      within(rail).getByRole('button', {
        name: /^sub-002, Reconstruction, Failed/,
      }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(rail).getByRole('button', { name: /^Cohort, ENIGMA QC, Blocked/ }),
    ).toBeInTheDocument()
    // Active and Completed list every run's jobs, so the chosen run keeps the
    // older run's running and queued jobs and the done job in view.
    expect(
      within(rail).getByRole('button', {
        name: /^sub-003, Reconstruction, Running/,
      }),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole('button', { name: /^sub-004, .*Queued/ }),
    ).toBeInTheDocument()
    expect(
      within(rail).getByRole('button', {
        name: /^sub-001, Reconstruction, Done/,
      }),
    ).toBeInTheDocument()
    // Another run's blocked job stays out of the chosen run's Blocked group.
    expect(
      within(rail).queryByRole('button', { name: /R analysis/ }),
    ).toBeNull()
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    expect(
      within(controls).getByText(fullText('sub-002 / Reconstruction')),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(forRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ runId: 'run-failed' }),
      ),
    )
  })

  it('names a newest run with no retained job while other runs stay choosable', async () => {
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-old-failure',
            runId: 'run-old',
            subjectId: 'sub-old-failure',
          }),
        ],
        {
          runs: [
            run(project, {
              runId: 'run-old',
              dryRun: false,
              startedAt: 100,
              endedAt: 200,
            }),
            run(project, {
              runId: 'run-latest',
              status: 'running',
              dryRun: false,
              startedAt: 2_000,
              endedAt: null,
            }),
          ],
          logTail: [],
        },
      ),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    expect(picker).toHaveValue('run-latest')
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      `${runListTime(2_000)}${TEXT_GAP}Running`,
      `${runListTime(100)}${TEXT_GAP}Failed`,
    ])
    expect(within(rail).queryByText('Needs attention')).toBeNull()

    fireEvent.change(picker, { target: { value: 'run-old' } })

    expect(picker).toHaveValue('run-old')
    expect(
      within(rail).getByRole('button', { name: /sub-old-failure/i }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the Run list label short and its full start time in the tooltip', async () => {
    // At 135% text a full start time such as "Sep 21, 2026, 8:34:05 PM" clips
    // the outcome in the closed list.
    const year = new Date().getFullYear()
    const thisYear = new Date(year, 0, 21, 20, 34, 5).getTime()
    const lastYear = new Date(year - 1, 8, 30, 12, 59, 7).getTime()
    const planAt = new Date(year, 0, 22, 9, 5, 0).getTime()
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-interrupted',
            runId: 'run-interrupted',
            status: 'interrupted',
            subjectId: 'sub-907',
            startedAt: thisYear,
            endedAt: thisYear + 1_000,
          }),
          job({
            id: 'job-old',
            runId: 'run-old',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-001',
            startedAt: lastYear,
            endedAt: lastYear + 1_000,
          }),
          job({
            id: 'job-plan',
            runId: 'run-plan',
            status: 'planned',
            dryRun: true,
            subjectId: 'sub-002',
            startedAt: null,
            endedAt: null,
            plannedAt: planAt,
            exitCode: null,
          }),
        ],
        {
          runs: [
            run(project, {
              runId: 'run-interrupted',
              status: 'interrupted',
              dryRun: false,
              startedAt: thisYear,
              endedAt: thisYear + 1_000,
            }),
            run(project, {
              runId: 'run-old',
              status: 'done',
              dryRun: false,
              startedAt: lastYear,
              endedAt: lastYear + 1_000,
            }),
            run(project, {
              runId: 'run-plan',
              status: 'planned',
              dryRun: true,
              startedAt: planAt,
              endedAt: planAt,
            }),
          ],
          logTail: [],
        },
      ),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    fireEvent.change(picker, { target: { value: 'run-interrupted' } })
    const options = within(picker).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      `${runListTime(planAt)}${TEXT_GAP}Dry-run plan`,
      `${runListTime(thisYear)}${TEXT_GAP}Interrupted`,
      `${runListTime(lastYear)}${TEXT_GAP}Done`,
    ])
    const [plan, interrupted, old] = options
    // No seconds anywhere, and the year only for a run of another year.
    for (const option of options) {
      expect(option.textContent).not.toMatch(/\d:\d\d:\d\d/)
    }
    expect(interrupted?.textContent).not.toContain(String(year))
    expect(old?.textContent).toContain(String(year - 1))
    expect(interrupted).toHaveAttribute(
      'title',
      `Started ${runTimestampLabel(thisYear)}${TEXT_GAP}Interrupted`,
    )
    expect(old).toHaveAttribute(
      'title',
      `Started ${runTimestampLabel(lastYear)}${TEXT_GAP}Done`,
    )
    expect(plan).toHaveAttribute(
      'title',
      `Started ${runTimestampLabel(planAt)}${TEXT_GAP}Dry-run plan`,
    )
    expect(picker).toHaveValue('run-interrupted')
    expect(picker).toHaveAttribute(
      'title',
      `Started ${runTimestampLabel(thisYear)}${TEXT_GAP}Interrupted`,
    )
  })

  it('gathers consecutive lines of one job under a single block header', async () => {
    await renderScreen((project) =>
      snapshot(project, [job(), job({ id: 'job-2', subjectId: 'sub-002' })], {
        logTail: [
          {
            id: 'log-1',
            runId: 'run-1',
            jobId: 'job-1',
            at: 100,
            level: 'INFO',
            line: 'first recon line',
          },
          {
            id: 'log-2',
            runId: 'run-1',
            jobId: 'job-1',
            at: 110,
            level: 'WARN',
            line: 'second recon line',
          },
          {
            id: 'log-3',
            runId: 'run-1',
            jobId: 'job-2',
            at: 120,
            level: 'INFO',
            line: 'other job line',
          },
        ],
      }),
    )

    expect(await screen.findByText('first recon line')).toBeInTheDocument()
    const stream = screen.getByRole('log', { name: 'Log stream output' })
    const blocks = within(stream).getAllByRole('group')
    expect(blocks).toHaveLength(2)
    const [first, second] = blocks as [HTMLElement, HTMLElement]
    expect(within(first).getAllByText('sub-001')).toHaveLength(1)
    expect(within(first).getAllByText('Reconstruction')).toHaveLength(1)
    expect(within(first).getByText('first recon line')).toBeInTheDocument()
    expect(within(first).getByText('second recon line')).toBeInTheDocument()
    expect(within(first).getAllByText('WARN')).toHaveLength(1)
    expect(within(second).getByText('sub-002')).toBeInTheDocument()
    expect(within(second).getByText('other job line')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Selected job' }))

    expect(within(stream).queryAllByRole('group')).toHaveLength(0)
    expect(within(stream).getByText('first recon line')).toBeInTheDocument()
    expect(within(stream).queryByText('sub-001')).toBeNull()
  })

  it('searches message and durable attribution fields case-insensitively', async () => {
    const targetJobId = 'job-target-1234567890-alpha'
    const targetRunId = 'run-target-1234567890-alpha'
    const target = job({
      id: targetJobId,
      runId: targetRunId,
      subjectId: 'sub-ALPHA',
      stepKey: 'recon',
      backend: 'fastsurfer',
      attemptOrdinal: 2,
    })
    const other = job({
      id: 'job-other',
      runId: 'run-other',
      subjectId: 'sub-BETA',
      stepKey: 'aggregate',
    })
    await renderScreen((project) =>
      snapshot(project, [target, other], {
        logTail: [
          {
            id: 'log-target',
            runId: targetRunId,
            jobId: targetJobId,
            at: 100,
            level: 'INFO',
            line: 'Surface pass complete',
          },
          {
            id: 'log-other',
            runId: 'run-other',
            jobId: 'job-other',
            at: 110,
            level: 'INFO',
            line: 'Unrelated aggregation output',
          },
        ],
      }),
    )
    expect(await screen.findByText('Surface pass complete')).toBeInTheDocument()
    const search = screen.getByRole('searchbox', {
      name: 'Search logs',
    })

    for (const query of [
      'SURFACE PASS',
      'sub-alpha',
      'RECONSTRUCTION',
      'recon',
      targetJobId.toUpperCase(),
      targetRunId.toUpperCase(),
      'FASTSURFER',
      'ATTEMPT 2',
    ]) {
      fireEvent.change(search, { target: { value: query } })
      expect(screen.getByText('Surface pass complete')).toBeInTheDocument()
      expect(
        screen.queryByText('Unrelated aggregation output'),
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('status', {
          name: 'Showing 1 of 2 retained log lines',
        }),
      ).toBeInTheDocument()
    }

    const rail = screen.getByRole('complementary', { name: 'Jobs' })
    const railButton = within(rail).getByRole('button', { name: /sub-alpha/i })
    expect(railButton.getAttribute('title') ?? '').not.toMatch(
      new RegExp(`${targetJobId}|${targetRunId}`),
    )
    const stream = screen.getByRole('log', { name: 'Log stream output' })
    expect(
      within(stream).queryByText(new RegExp(`${targetJobId}|${targetRunId}`)),
    ).toBeNull()
    const targetRow = within(stream)
      .getByText('Surface pass complete')
      .closest('[data-job-id]')
    expect(targetRow).toHaveAttribute('data-job-id', targetJobId)
    expect(targetRow).toHaveAttribute('data-run-id', targetRunId)
  })

  it('reports no matches and clears a log search without changing filters', async () => {
    await renderScreen((project) =>
      snapshot(project, [job()], {
        logTail: [
          {
            id: 'log-info',
            runId: 'run-1',
            jobId: 'job-1',
            at: 100,
            level: 'INFO',
            line: 'ordinary progress',
          },
        ],
      }),
    )
    expect(await screen.findByText('ordinary progress')).toBeInTheDocument()
    const search = screen.getByRole('searchbox', {
      name: 'Search logs',
    })
    const clear = screen.getByRole('button', { name: 'Clear log search' })
    expect(clear).toBeDisabled()

    fireEvent.change(search, { target: { value: 'no-such-token' } })

    expect(
      screen.getByText('No log lines match "no-such-token".'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Clear the search or change the scope or level threshold.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/because/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('status', {
        name: 'Showing 0 of 1 retained log lines',
      }),
    ).toHaveTextContent(/^0 of 1 line$/)
    expect(
      screen.getByText('0 lines, Info and above, matching "no-such-token"'),
    ).toBeInTheDocument()
    expect(clear).toBeEnabled()

    fireEvent.click(clear)

    expect(search).toHaveValue('')
    expect(screen.getByText('ordinary progress')).toBeInTheDocument()
    expect(clear).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'All jobs' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Info' })).toBeChecked()
  })

  it('opens on the newest job of the newest run, not the first job listed', async () => {
    const api = createMockApi()
    const forRun = vi.spyOn(api.manifest, 'forRun')
    await renderScreen(
      (project) =>
        snapshot(
          project,
          [
            job({
              id: 'job-old',
              runId: 'run-old',
              subjectId: 'sub-120',
              status: 'done',
              exitCode: 0,
              startedAt: 100,
              endedAt: 200,
            }),
            job({
              id: 'job-new-early',
              runId: 'run-new',
              subjectId: 'sub-001',
              status: 'done',
              exitCode: 0,
              startedAt: 1_000,
              endedAt: 1_100,
            }),
            job({
              id: 'job-new',
              runId: 'run-new',
              subjectId: null,
              stepKey: 'brainpad',
              status: 'done',
              exitCode: 0,
              startedAt: 1_200,
              endedAt: 1_300,
            }),
          ],
          {
            runs: [
              run(project, { runId: 'run-old', startedAt: 100, endedAt: 200 }),
              run(project, {
                runId: 'run-new',
                status: 'done',
                startedAt: 1_000,
                endedAt: 1_300,
              }),
            ],
          },
        ),
      api,
    )

    const controls = await screen.findByRole('complementary', {
      name: 'Controls',
    })
    expect(
      await within(controls).findByText('cohort / Brain-PAD statistics'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(forRun).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-new' }),
      ),
    )
    expect(forRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-old' }),
    )

    // An explicit selection still wins over the default.
    const rail = screen.getByRole('complementary', { name: 'Jobs' })
    fireEvent.click(within(rail).getByRole('button', { name: /sub-120/ }))
    expect(
      within(controls).getByText(fullText('sub-120 / Reconstruction')),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(forRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ runId: 'run-old' }),
      ),
    )
  })

  it('opens on a running job before any finished job', async () => {
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({ id: 'job-done', subjectId: 'sub-001', endedAt: 5_000 }),
          job({
            id: 'job-running-early',
            subjectId: 'sub-002',
            status: 'running',
            startedAt: 1_000,
            endedAt: null,
            exitCode: null,
          }),
          job({
            id: 'job-running',
            subjectId: 'sub-003',
            status: 'running',
            startedAt: 2_000,
            endedAt: null,
            exitCode: null,
          }),
        ],
        { logTail: [] },
      ),
    )

    const controls = await screen.findByRole('complementary', {
      name: 'Controls',
    })
    expect(
      await within(controls).findByText(fullText('sub-003 / Reconstruction')),
    ).toBeInTheDocument()
  })

  it('says a selected job with no retained lines is outside the tail instead of asking for a level change', async () => {
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({ startedAt: 50, endedAt: 90 }),
          job({ id: 'job-2', subjectId: 'sub-002' }),
        ],
        {
          logTail: [
            {
              id: 'log-1',
              runId: 'run-1',
              jobId: 'job-2',
              at: 100,
              level: 'INFO',
              line: 'second job progress',
            },
            {
              id: 'log-2',
              runId: 'run-1',
              jobId: 'job-2',
              at: 110,
              level: 'INFO',
              line: 'second job done',
            },
          ],
        },
      ),
    )
    expect(await screen.findByText('second job done')).toBeInTheDocument()

    // The older job started before the oldest retained line, so its lines may
    // have been trimmed from the tail.
    const rail = screen.getByRole('complementary', { name: 'Jobs' })
    fireEvent.click(within(rail).getByRole('button', { name: /sub-001/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Selected job' }))

    expect(screen.getByRole('radio', { name: 'Info' })).toBeChecked()
    expect(
      screen.getByText(
        'No lines from sub-001 / Reconstruction are in the retained log tail.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'The tail keeps only the newest 2 lines across all jobs. The complete job log remains in backend-owned storage.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Change the level/)).not.toBeInTheDocument()
  })

  it('says a job newer than every retained line wrote no log lines instead of blaming the tail', async () => {
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            status: 'done',
            exitCode: 0,
            startedAt: 100,
            endedAt: 200,
          }),
          job({
            id: 'job-stats',
            subjectId: null,
            stepKey: 'brainpad',
            status: 'done',
            exitCode: 0,
            startedAt: 300,
            endedAt: 305,
          }),
          job({
            id: 'job-blocked',
            subjectId: null,
            stepKey: 'final',
            status: 'blocked',
            exitCode: null,
            startedAt: null,
            endedAt: 306,
          }),
          job({
            id: 'job-running',
            subjectId: 'sub-002',
            status: 'running',
            exitCode: null,
            startedAt: 310,
            endedAt: null,
          }),
        ],
        {
          // The replay read both finished jobs' whole log files; the
          // Brain-PAD statistics log held no line.
          logReplay: [
            { runId: 'run-1', jobId: 'job-1', lines: 2, complete: true },
            { runId: 'run-1', jobId: 'job-stats', lines: 0, complete: true },
          ],
          // A restart replays each job's lines from its order time onward.
          logTail: [
            {
              id: 'log-1',
              runId: 'run-1',
              jobId: 'job-1',
              at: 200,
              level: 'INFO',
              line: 'recon finished',
            },
            {
              id: 'log-2',
              runId: 'run-1',
              jobId: 'job-1',
              at: 201,
              level: 'INFO',
              line: 'recon outputs published',
            },
          ],
        },
      ),
    )
    expect(
      await screen.findByText('recon outputs published'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Selected job' }))

    expect(
      screen.getByText(
        'sub-002 / Reconstruction has written no log lines yet.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Its lines appear here as it writes them.'),
    ).toBeInTheDocument()

    const rail = screen.getByRole('complementary', { name: 'Jobs' })
    fireEvent.click(
      within(rail).getByRole('button', { name: /^Cohort, Brain-PAD/ }),
    )
    expect(
      screen.getByText('cohort / Brain-PAD statistics wrote no log lines.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Its log file is empty.')).toBeInTheDocument()

    fireEvent.click(
      within(rail).getByRole('button', { name: /^Cohort, R analysis/ }),
    )
    expect(
      screen.getByText('cohort / R analysis wrote no log lines.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('It did not start, so it has no log.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/The tail keeps only/)).not.toBeInTheDocument()
    expect(
      screen.queryByText(/are in the retained log tail/),
    ).not.toBeInTheDocument()
  })

  it('claims an empty log only from the replay record, not from an old error marker', async () => {
    // The replay stops after 512 log files, yet it still emits the terminal
    // ERROR marker of every older failed job. That old marker must not make a
    // later job the replay never read look newer than the tail, and so empty.
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-old',
            subjectId: 'sub-001',
            status: 'failed',
            exitCode: 1,
            startedAt: 10,
            endedAt: 20,
          }),
          job({
            id: 'job-unread',
            subjectId: 'sub-002',
            status: 'done',
            exitCode: 0,
            startedAt: 300,
            endedAt: 400,
          }),
          job({
            id: 'job-trimmed',
            subjectId: 'sub-003',
            status: 'done',
            exitCode: 0,
            startedAt: 500,
            endedAt: 600,
          }),
          job({
            id: 'job-empty',
            subjectId: 'sub-004',
            status: 'done',
            exitCode: 0,
            startedAt: 700,
            endedAt: 800,
          }),
        ],
        {
          // `job-unread` was never opened; `job-trimmed` was read in full but
          // its lines fell out of the bounded tail; `job-empty`'s file was
          // empty.
          logReplay: [
            { runId: 'run-1', jobId: 'job-trimmed', lines: 40, complete: true },
            { runId: 'run-1', jobId: 'job-empty', lines: 0, complete: true },
          ],
          logTail: [
            {
              id: 'log-marker',
              runId: 'run-1',
              jobId: 'job-old',
              at: 20,
              level: 'ERROR',
              line: 'Investigate the failed job (exit code 1).',
            },
          ],
        },
      ),
    )
    expect(
      await screen.findByText(
        'The job failed (exit code 1) with no recorded reason.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Selected job' }))
    const rail = screen.getByRole('complementary', { name: 'Jobs' })

    fireEvent.click(within(rail).getByRole('button', { name: /sub-002/ }))
    expect(
      screen.getByText(
        'No lines from sub-002 / Reconstruction are in the retained log tail.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/wrote no log lines/)).not.toBeInTheDocument()

    fireEvent.click(within(rail).getByRole('button', { name: /sub-003/ }))
    expect(
      screen.getByText(
        'No lines from sub-003 / Reconstruction are in the retained log tail.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(within(rail).getByRole('button', { name: /sub-004/ }))
    expect(
      screen.getByText('sub-004 / Reconstruction wrote no log lines.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Its log file is empty.')).toBeInTheDocument()
  })

  it('keeps the live inference for a job that started after the snapshot', async () => {
    const api = createMockApi()
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    const { result } = await renderScreen(
      (project) =>
        snapshot(project, [job({ status: 'done', exitCode: 0 })], {
          logReplay: [
            { runId: 'run-1', jobId: 'job-1', lines: 1, complete: true },
          ],
          logTail: [
            {
              id: 'log-1',
              runId: 'run-1',
              jobId: 'job-1',
              at: 200,
              level: 'INFO',
              line: 'recon finished',
            },
          ],
        }),
      api,
    )
    expect(await screen.findByText('recon finished')).toBeInTheDocument()
    const identity = {
      projectId: result.project.projectId,
      projectEpoch: result.project.epoch,
      sidecarGeneration: 1,
      runId: 'run-1',
    }
    // A job the snapshot never listed starts and finishes live without a
    // line, and a live line from another job arrives; neither changes the
    // snapshot's replay record.
    await act(async () => {
      publish?.({
        ...identity,
        kind: 'job',
        sequence: 5,
        at: 600,
        job: {
          ...job({
            id: 'job-late',
            subjectId: 'sub-002',
            status: 'done',
            exitCode: 0,
            startedAt: 500,
            endedAt: 600,
          }),
          projectId: result.project.projectId,
          projectEpoch: result.project.epoch,
          sidecarGeneration: 1,
        },
      })
      publish?.({
        ...identity,
        kind: 'log',
        sequence: 6,
        at: 650,
        log: {
          id: 'log-2',
          runId: 'run-1',
          jobId: 'job-1',
          at: 650,
          level: 'INFO',
          line: 'late recon note',
        },
      })
    })
    expect(await screen.findByText('late recon note')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Selected job' }))
    const rail = screen.getByRole('complementary', { name: 'Jobs' })
    fireEvent.click(within(rail).getByRole('button', { name: /sub-002/ }))
    expect(
      screen.getByText('sub-002 / Reconstruction wrote no log lines.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Its log file is empty.')).toBeInTheDocument()
  })

  it('keeps the level advice when a higher level hides lines the selected job has', async () => {
    await renderScreen((project) =>
      snapshot(project, [job()], {
        logTail: [
          {
            id: 'log-info',
            runId: 'run-1',
            jobId: 'job-1',
            at: 100,
            level: 'INFO',
            line: 'ordinary progress',
          },
        ],
      }),
    )
    expect(await screen.findByText('ordinary progress')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Selected job' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Warn' }))

    expect(
      screen.getByText('No WARN+ lines exist for sub-001 / Reconstruction.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Choose a lower level threshold to show its other lines. This view shows the bounded durable tail. Complete logs remain in backend-owned storage.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/are in the retained log tail/),
    ).not.toBeInTheDocument()
  })

  it('states that a level matches nothing in the scope and moves the remedy to the hint', async () => {
    await renderScreen((project) =>
      snapshot(project, [job()], {
        logTail: [
          {
            id: 'log-info',
            runId: 'run-1',
            jobId: 'job-1',
            at: 100,
            level: 'INFO',
            line: 'ordinary progress',
          },
        ],
      }),
    )
    expect(await screen.findByText('ordinary progress')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Error' }))

    expect(screen.getByRole('radio', { name: 'All jobs' })).toBeChecked()
    expect(
      screen.getByText('No ERROR+ log lines appear in this scope.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Change the scope or level threshold. This view shows the bounded durable tail. Complete logs remain in backend-owned storage.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Change the scope because/)).toBeNull()
  })

  it('shows the recorded exit code and terminal reason for a failed job', async () => {
    await renderScreen((project) =>
      snapshot(project, [
        job({
          exitCode: 137,
          terminalReason:
            'Review the process termination after an out-of-memory kill.',
        }),
      ]),
    )

    const outcome = await screen.findByRole('region', {
      name: 'Result',
    })
    expect(within(outcome).getByText('Exit code')).toBeInTheDocument()
    expect(within(outcome).getByText('137')).toBeInTheDocument()
    expect(within(outcome).getByText('Reason')).toBeInTheDocument()
    expect(
      within(outcome).getByText(
        'Review the process termination after an out-of-memory kill.',
      ),
    ).toBeInTheDocument()
  })

  it("states a failed Reconstruction's cause beside its terminal reason", async () => {
    // The closing line of recon-all alone hides the failing step.
    await renderScreen((project) =>
      snapshot(project, [
        job({
          exitCode: 1,
          terminalReason:
            'recon-all -s sub-101 exited with ERRORS at Thu Jan  1 22:15:33 UTC 2026',
          failureCause: 'label-cortex failed: found no voxels matching id 1',
        }),
      ]),
    )

    const outcome = await screen.findByRole('region', {
      name: 'Result',
    })
    expect(within(outcome).getByText('Cause')).toBeInTheDocument()
    expect(
      within(outcome).getByText(
        'label-cortex failed: found no voxels matching id 1.',
      ),
    ).toBeInTheDocument()
    expect(
      within(outcome).getByText(/exited with ERRORS at Thu Jan\s+1/),
    ).toBeInTheDocument()
  })

  it('states which subjects a cohort stage computed and reused', async () => {
    await renderScreen((project) =>
      snapshot(project, [
        job({
          stepKey: 'enigma',
          subjectId: null,
          status: 'done',
          exitCode: 0,
          terminalReason: 'completed',
          unitReuse: {
            computedSubjectIds: ['sub-009'],
            reusedSubjectIds: ['sub-001', 'sub-002'],
            sourceRunIds: ['run-8407b948c62b'],
          },
        }),
      ]),
    )

    const outcome = await screen.findByRole('region', {
      name: 'Result',
    })
    expect(within(outcome).getByText('Subjects')).toBeInTheDocument()
    expect(
      within(outcome).getByText(
        'Computed 1 subject and reused the verified output of 2 subjects from run-8407b948c62b.',
      ),
    ).toBeInTheDocument()
  })

  it('states a Reconstruction rerun in the terminal outcome', async () => {
    // The rerun must show outside the receipt JSON.
    await renderScreen((project) =>
      snapshot(project, [
        job({
          status: 'done',
          exitCode: 0,
          terminalReason: 'completed',
          executionFallback: {
            kind: 'freesurfer-no-fix-ga+freesurfer-no-fix-with-ga',
            addedArguments: ['-no-fix-ga', '-no-fix-with-ga'],
            reason: 'Label reason. Topology reason.',
            firstAttemptExitCode: 1,
            reruns: [
              {
                kind: 'freesurfer-no-fix-ga',
                addedArguments: ['-no-fix-ga'],
                reason: 'Label reason.',
                attemptExitCode: 1,
              },
              {
                kind: 'freesurfer-no-fix-with-ga',
                addedArguments: ['-no-fix-with-ga'],
                reason: 'Topology reason.',
                attemptExitCode: 134,
              },
            ],
          },
        }),
      ]),
    )

    const outcome = await screen.findByRole('region', {
      name: 'Result',
    })
    expect(within(outcome).getByText('Rerun')).toBeInTheDocument()
    expect(
      within(outcome).getByText('Reran with -no-fix-ga and -no-fix-with-ga.'),
    ).toBeInTheDocument()
    expect(
      within(outcome).getByText(
        'Label reason. Topology reason. The first attempt exited with code 1.',
      ),
    ).toBeInTheDocument()
  })

  it('states no rerun for a job that did not rerun', async () => {
    await renderScreen((project) =>
      snapshot(project, [job({ exitCode: 1, terminalReason: 'failed' })]),
    )

    const outcome = await screen.findByRole('region', {
      name: 'Result',
    })
    expect(within(outcome).queryByText('Rerun')).not.toBeInTheDocument()
  })

  it('reads a separator line recorded as the reason as not recorded', async () => {
    // A reason with no letter or digit, such as a log separator line.
    const separator = '-'.repeat(58)
    await renderScreen((project) =>
      snapshot(project, [job({ exitCode: 1, terminalReason: separator })]),
    )

    const outcome = await screen.findByRole('region', {
      name: 'Result',
    })
    expect(within(outcome).getByText('Reason')).toBeInTheDocument()
    expect(within(outcome).getByText('Not recorded')).toBeInTheDocument()
    expect(screen.queryByText(separator)).not.toBeInTheDocument()
  })

  it('omits the Reason row for a clean exit with no recorded reason', async () => {
    await renderScreen((project) =>
      snapshot(project, [job({ status: 'done', exitCode: 0 })]),
    )

    const outcome = await screen.findByRole('region', { name: 'Result' })
    expect(within(outcome).getByText('Exit code')).toBeInTheDocument()
    expect(within(outcome).getByText('0')).toBeInTheDocument()
    expect(within(outcome).queryByText('Reason')).toBeNull()
    expect(within(outcome).queryByText('Not recorded')).toBeNull()
  })

  it('keeps the Reason row for a nonzero exit with no recorded reason', async () => {
    await renderScreen((project) => snapshot(project, [job({ exitCode: 2 })]))

    const outcome = await screen.findByRole('region', { name: 'Result' })
    expect(within(outcome).getByText('Reason')).toBeInTheDocument()
    expect(within(outcome).getByText('Not recorded')).toBeInTheDocument()
  })

  it.each([
    ['the current sidecar', 'Reconstruction failed, so this step did not run.'],
  ])(
    'states the blocked-dependency reason %s recorded as a fact',
    async (_build, recorded) => {
      await renderScreen((project) =>
        snapshot(project, [
          job({
            stepKey: 'enigma',
            subjectId: null,
            status: 'blocked',
            exitCode: null,
            startedAt: null,
            terminalReason: recorded,
          }),
        ]),
      )

      const outcome = await screen.findByRole('region', {
        name: 'Result',
      })
      expect(
        within(outcome).getByText(
          'Reconstruction failed, so this step did not run.',
        ),
      ).toBeInTheDocument()
      expect(screen.queryByText(/Resolve dependency/)).not.toBeInTheDocument()
    },
  )

  it('restates the blocked-dependency reason in the replayed error line', async () => {
    // After a restart the sidecar replays one ERROR marker per stored terminal
    // job, quoting its recorded reason, so the stream must restate it as the
    // Terminal reason does.
    const recorded = 'Reconstruction failed, so this step did not run.'
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            stepKey: 'enigma',
            subjectId: null,
            status: 'blocked',
            exitCode: null,
            startedAt: null,
            terminalReason: recorded,
          }),
        ],
        {
          logTail: [
            {
              id: 'log-replay-blocked',
              runId: 'run-1',
              jobId: 'job-1',
              at: 200,
              level: 'ERROR',
              line: `Resolve the blocked job: ${recorded}`,
            },
          ],
        },
      ),
    )

    const stream = await screen.findByRole('log', { name: 'Log stream output' })
    await within(stream).findByText(/^The job was blocked: /)
    const restated =
      'The job was blocked: Reconstruction failed, so this step did not run.'
    expect(within(stream).getByText(restated)).toBeInTheDocument()
    expect(
      screen.queryByText(/Resolve the blocked job/),
    ).not.toBeInTheDocument()

    const search = screen.getByRole('searchbox', { name: 'Search logs' })
    fireEvent.change(search, { target: { value: 'reconstruction failed' } })
    expect(within(stream).getByText(restated)).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'resolve the blocked job' } })
    expect(within(stream).queryByText(restated)).not.toBeInTheDocument()
  })

  it('states the readiness order a blocked cohort job records with stage names', async () => {
    // A blocked ENIGMA QC job records this order as its reason; the Terminal
    // reason and the error line state it as a fact with stage names.
    const recorded =
      'Rerun recon before enigma because no matching current provenance receipt exists.'
    const fact = 'Reconstruction has no current receipt for ENIGMA QC.'
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            stepKey: 'enigma',
            subjectId: null,
            status: 'blocked',
            exitCode: null,
            startedAt: null,
            terminalReason: recorded,
          }),
        ],
        {
          logTail: [
            {
              id: 'log-replay-readiness',
              runId: 'run-1',
              jobId: 'job-1',
              at: 200,
              level: 'ERROR',
              line: `Resolve the blocked job: ${recorded}`,
            },
          ],
        },
      ),
    )

    const outcome = await screen.findByRole('region', {
      name: 'Result',
    })
    expect(within(outcome).getByText(fact)).toBeInTheDocument()
    const stream = await screen.findByRole('log', { name: 'Log stream output' })
    const line = `The job was blocked: ${fact}`
    expect(within(stream).getByText(line)).toBeInTheDocument()
    expect(screen.queryByText(/Rerun recon/)).not.toBeInTheDocument()

    const search = screen.getByRole('searchbox', { name: 'Search logs' })
    fireEvent.change(search, { target: { value: 'no current receipt' } })
    expect(within(stream).getByText(line)).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'rerun recon' } })
    expect(within(stream).queryByText(line)).not.toBeInTheDocument()
  })

  it.each([
    [
      'an interrupted job after a restart',
      { status: 'interrupted', exitCode: null },
      'stale_sidecar_generation',
      'Resume the interrupted job: stale_sidecar_generation.',
      'The job was interrupted: the job was still queued when Supraspina restarted.',
      'still queued',
      'stale_sidecar_generation',
    ],
    [
      'a failure that recorded a log trailer',
      { status: 'failed', exitCode: 1 },
      '-'.repeat(58),
      `Investigate the failed job (exit code 1): ${'-'.repeat(58)}.`,
      'The job failed (exit code 1) with no recorded reason.',
      'no recorded reason',
      'investigate',
    ],
    [
      'a job whose state was not persisted',
      { status: 'persistence-error', exitCode: 0 },
      'persistence_error',
      'Repair job persistence (exit code 0): persistence_error.',
      "Supraspina could not persist the job's state (exit code 0).",
      'could not persist',
      'repair job persistence',
    ],
    [
      // A stage tool failure recorded as an order.
      'a failure a stage tool recorded as an order',
      { status: 'failed', exitCode: 1 },
      'Inspect process exit code 1.',
      'Investigate the failed job (exit code 1): Inspect process exit code 1.',
      'The job failed (exit code 1): The process exited with code 1.',
      'the process exited',
      'inspect process exit code',
    ],
  ] as const)(
    'states the error marker of %s as a fact',
    async (_case, outcome, terminalReason, marker, restated, found, missed) => {
      // The sidecar's marker opens with an order and quotes the raw reason
      // code; the stream states the outcome and the reason as the Reason field
      // does, and search reads the restated text.
      await renderScreen((project) =>
        snapshot(project, [job({ ...outcome, terminalReason })], {
          logTail: [
            {
              id: 'log-replay-0123456789abcdef',
              runId: 'run-1',
              jobId: 'job-1',
              at: 200,
              level: 'ERROR',
              line: marker,
            },
          ],
        }),
      )

      const stream = await screen.findByRole('log', {
        name: 'Log stream output',
      })
      const line = await within(stream).findByText(restated)
      expect(line.closest('[data-level]')).toHaveAttribute(
        'data-level',
        'ERROR',
      )
      expect(screen.queryByText(marker)).not.toBeInTheDocument()

      const search = screen.getByRole('searchbox', { name: 'Search logs' })
      fireEvent.change(search, { target: { value: found } })
      expect(within(stream).getByText(restated)).toBeInTheDocument()
      fireEvent.change(search, { target: { value: missed } })
      expect(within(stream).queryByText(restated)).not.toBeInTheDocument()
    },
  )

  it('states a recorded cancellation code as a readable fact', async () => {
    await renderScreen((project) =>
      snapshot(project, [
        job({
          status: 'cancelled',
          exitCode: null,
          terminalReason: 'operator_cancelled',
        }),
      ]),
    )

    const outcome = await screen.findByRole('region', {
      name: 'Result',
    })
    expect(
      within(outcome).getByText("Canceled at the operator's request."),
    ).toBeInTheDocument()
    expect(screen.queryByText('operator_cancelled')).not.toBeInTheDocument()
  })

  it('names a job row and a run option by the status word of the badge', async () => {
    // The rail row of a canceled job must not be announced and titled "sub-912,
    // Reconstruction, cancelled, ..." beside its "Canceled" badge.
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-canceled',
            runId: 'run-canceled',
            status: 'cancelled',
            subjectId: 'sub-912',
            exitCode: null,
            startedAt: 100,
            endedAt: 200,
          }),
          job({
            id: 'job-storage',
            runId: 'run-storage',
            status: 'persistence-error',
            subjectId: 'sub-913',
            startedAt: 300,
            endedAt: 400,
          }),
        ],
        {
          runs: [
            run(project, {
              runId: 'run-canceled',
              status: 'cancelled',
              dryRun: false,
              startedAt: 100,
              endedAt: 200,
            }),
            run(project, {
              runId: 'run-storage',
              status: 'persistence-error',
              dryRun: false,
              startedAt: 300,
              endedAt: 400,
            }),
          ],
          logTail: [],
        },
      ),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    fireEvent.change(picker, { target: { value: 'run-canceled' } })
    const row = within(rail).getByRole('button', { name: /^sub-912,/ })
    const name = `sub-912, Reconstruction, Canceled, finished ${new Date(
      200,
    ).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })}.`
    expect(row).toHaveAccessibleName(name)
    expect(row).toHaveAttribute('title', name)
    expect(within(row).getByText('Canceled')).toBeInTheDocument()
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      `${runListTime(300)}${TEXT_GAP}Storage error`,
      `${runListTime(100)}${TEXT_GAP}Canceled`,
    ])
    for (const element of [
      ...within(rail).getAllByRole('button'),
      ...within(picker).getAllByRole('option'),
    ]) {
      const announced = `${element.getAttribute('aria-label') ?? ''} ${
        element.getAttribute('title') ?? ''
      } ${element.textContent ?? ''}`
      expect(announced).not.toMatch(/cancelled|persistence-error/)
    }
  })

  it('states stage tool progress lines as facts and searches the facts', async () => {
    // The aggregation tool writes "Review <file> with 82 rows and 70
    // structures." and "Process 82 discovered subjects." to the R analysis stream,
    // and the receipts bind those lines as written.
    const line = (
      id: string,
      at: number,
      level: 'INFO' | 'WARN',
      text: string,
    ) => ({
      id,
      runId: 'run-1',
      jobId: 'job-1',
      at,
      level,
      line: text,
    })
    await renderScreen((project) =>
      snapshot(project, [job({ status: 'done', exitCode: 0 })], {
        logTail: [
          line(
            'log-1',
            150,
            'WARN',
            'Review only the bounded restart replay; expect earlier log content to be omitted.',
          ),
          line('log-2', 151, 'INFO', 'Process 82 discovered subjects.'),
          line(
            'log-3',
            152,
            'INFO',
            'Review /p/wm_volumes.csv with 82 rows and 70 structures.',
          ),
          line('log-5', 154, 'INFO', 'Loading lh.aparc.stats'),
        ],
      }),
    )

    const stream = await screen.findByRole('log', { name: 'Log stream output' })
    const found = await within(stream).findByText('Found 82 subjects.')
    expect(found.closest('[data-level]')).toHaveAttribute('data-level', 'INFO')
    const wrote = 'Wrote /p/wm_volumes.csv: 82 rows and 70 structures.'
    expect(within(stream).getByText(wrote)).toBeInTheDocument()
    const bounded =
      'The restart replay is bounded, so earlier log content is omitted.'
    expect(within(stream).getByText(bounded)).toBeInTheDocument()
    // Tool output that is not one of those orders reads as written.
    expect(
      within(stream).getByText('Loading lh.aparc.stats'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/discovered subjects/)).not.toBeInTheDocument()
    expect(within(stream).queryByText(/^Review /)).not.toBeInTheDocument()
    expect(within(stream).queryByText(/^Resolve /)).not.toBeInTheDocument()

    const search = screen.getByRole('searchbox', { name: 'Search logs' })
    fireEvent.change(search, { target: { value: 'wrote 82 rows' } })
    expect(within(stream).getByText(wrote)).toBeInTheDocument()
    expect(
      within(stream).queryByText('Found 82 subjects.'),
    ).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'discovered subjects' } })
    expect(
      within(stream).queryByText('Found 82 subjects.'),
    ).not.toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'found 82' } })
    expect(within(stream).getByText('Found 82 subjects.')).toBeInTheDocument()
  })

  it('states a pending cancellation code as a readable fact', async () => {
    await renderScreen((project) =>
      snapshot(project, [
        job({
          status: 'cancelling',
          endedAt: null,
          exitCode: null,
          terminalReason: 'operator_cancellation_requested',
        }),
      ]),
    )

    expect(
      await screen.findByText('The operator requested cancellation.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('operator_cancellation_requested'),
    ).not.toBeInTheDocument()
  })

  it('uses the recorded level even when external output contains error words', async () => {
    await renderScreen((project) =>
      snapshot(project, [job()], {
        logTail: [
          {
            id: 'stdout-error-word',
            runId: 'run-1',
            jobId: 'job-1',
            at: 100,
            level: 'INFO',
            line: 'External stdout says ERROR while still reporting progress',
          },
        ],
      }),
    )

    const message = await screen.findByText(
      'External stdout says ERROR while still reporting progress',
    )
    expect(message.closest('[data-level]')).toHaveAttribute(
      'data-level',
      'INFO',
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Warn' }))
    expect(
      screen.queryByText(
        'External stdout says ERROR while still reporting progress',
      ),
    ).not.toBeInTheDocument()
  })

  it('groups every durable status and exposes fallback job provenance', async () => {
    const plannedJob = job({
      id: 'job-planned',
      status: 'planned',
      dryRun: true,
      subjectId: null,
      stepKey: 'custom-stage' as Job['stepKey'],
      startedAt: null,
      endedAt: null,
      plannedAt: 30,
      exitCode: null,
      cmd: '',
      terminalReason: 'Wait for an operator decision.',
    })
    delete plannedJob.runId
    delete plannedJob.nodeId
    const statuses: Job[] = [
      plannedJob,
      job({
        id: 'job-waiting',
        status: 'waiting',
        subjectId: 'sub-002',
        startedAt: 20,
        endedAt: null,
        plannedAt: 10,
        exitCode: null,
      }),
      job({
        id: 'job-running',
        status: 'running',
        subjectId: 'sub-003',
        startedAt: null,
        endedAt: null,
        exitCode: null,
      }),
      job({
        id: 'job-cancelling',
        status: 'cancelling',
        subjectId: 'sub-004',
        startedAt: 40,
        endedAt: null,
        exitCode: null,
      }),
      job({
        id: 'job-done',
        status: 'done',
        subjectId: 'sub-010',
        backend: 'fastsurfer',
        attemptOrdinal: 2,
        role: 'fallback',
        supersedesJobId: 'job-primary',
        fallbackReasonTag: 'freesurfer_topology_failure',
      }),
      job({ id: 'job-failed', status: 'failed', subjectId: 'sub-011' }),
      job({
        id: 'job-persistence',
        status: 'persistence-error',
        subjectId: 'sub-012',
      }),
      job({ id: 'job-blocked', status: 'blocked', subjectId: 'sub-013' }),
      job({ id: 'job-withheld', status: 'withheld', subjectId: 'sub-014' }),
      job({ id: 'job-unknown', status: 'unknown', subjectId: 'sub-015' }),
      job({ id: 'job-stale', status: 'stale', subjectId: 'sub-016' }),
      job({ id: 'job-cancelled', status: 'cancelled', subjectId: 'sub-017' }),
      job({
        id: 'job-interrupted',
        status: 'interrupted',
        subjectId: 'sub-018',
      }),
    ]
    await renderScreen((project) => snapshot(project, statuses))

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    expect(await within(rail).findByText('custom-stage')).toBeInTheDocument()
    expect(within(rail).getByText('Dry-run plans')).toBeInTheDocument()
    expect(within(rail).getByText('Completed')).toBeInTheDocument()
    expect(within(rail).getByText('Needs attention')).toBeInTheDocument()
    expect(within(rail).getAllByText('Blocked').length).toBeGreaterThan(1)
    // Logs opens on the running job; select the run-less plan explicitly.
    fireEvent.click(
      within(rail).getByRole('button', { name: /^Cohort, custom-stage/ }),
    )
    expect(
      screen.getByText('Wait for an operator decision.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('This job has no durable run identity.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('region', {
        name: 'Reconstruction attempt provenance',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('This job has no recorded command.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeDisabled()
    // A plan has no retry.
    expect(
      within(
        screen.getByRole('group', { name: 'Selected job actions' }),
      ).queryByRole('button', { name: /Retry/ }),
    ).not.toBeInTheDocument()

    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    fireEvent.click(
      within(rail).getByRole('button', { name: /sub-010.*done/i }),
    )
    const provenance = screen.getByRole('region', {
      name: 'Reconstruction attempt provenance',
    })
    expect(within(provenance).getByText('FastSurfer')).toBeInTheDocument()
    expect(within(provenance).getByText('2')).toBeInTheDocument()
    expect(within(provenance).getByText('Fallback')).toBeInTheDocument()
    expect(
      within(provenance).getByText('an earlier attempt in this run'),
    ).toBeInTheDocument()
    expect(within(provenance).queryByText('job-primary')).toBeNull()
    expect(
      within(provenance).getByText('freesurfer_topology_failure'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeEnabled()
    expect(writeText).toHaveBeenCalledWith('recon-all -s sub-001')
    // Only an unusual run states itself beside the selected job.
    expect(screen.getByText('This run is a dry run.')).toBeInTheDocument()
    expect(screen.queryByText(/^This job belongs to the run/)).toBeNull()
  })

  it.each(['failed', 'interrupted', 'cancelled'] as const)(
    'offers Retry job for a %s job',
    async (status) => {
      await renderScreen((project) => snapshot(project, [job({ status })]))

      const actions = await screen.findByRole('group', {
        name: 'Selected job actions',
      })
      const retry = within(actions).getByRole('button', { name: /Retry/ })
      expect(retry).toHaveAccessibleName('Retry job')
      expect(retry).toBeEnabled()
    },
  )

  it.each([
    'blocked',
    'withheld',
    'stale',
    'persistence-error',
    'unknown',
    'done',
    'planned',
    'waiting',
    'queued',
    'running',
    'cancelling',
  ] as const)('offers no retry of a %s job', async (status) => {
    // A blocked job must not show a disabled "Retry job" that no state
    // of the job could enable.
    await renderScreen((project) =>
      snapshot(project, [
        job({
          status,
          exitCode: null,
          terminalReason:
            'Rerun recon before enigma because no matching current provenance receipt exists.',
        }),
      ]),
    )

    const actions = await screen.findByRole('group', {
      name: 'Selected job actions',
    })
    expect(
      within(actions).getByRole('button', { name: 'Copy command' }),
    ).toBeInTheDocument()
    expect(
      within(actions).queryByRole('button', { name: /Retry/ }),
    ).not.toBeInTheDocument()
  })

  it('keeps the retry of a failed job without a node identity off, with why', async () => {
    const orphan = job()
    delete orphan.nodeId
    await renderScreen((project) => snapshot(project, [orphan]))

    const actions = await screen.findByRole('group', {
      name: 'Selected job actions',
    })
    const retry = within(actions).getByRole('button', {
      name: 'Retry job',
    })
    expect(retry).toBeDisabled()
    expect(retry).toHaveAttribute(
      'title',
      'This job has no durable workflow identity.',
    )
  })

  it('draws the running Tailing chip only while the shown run is active', async () => {
    await renderScreen((project) =>
      snapshot(project, [job({ status: 'running' })], { logTail: [] }),
    )
    expect(
      await screen.findByRole('status', { name: /^Tailing, / }),
    ).toHaveTextContent('Tailing')
  })

  it('pauses and explicitly resumes auto-tail', async () => {
    await renderScreen((project) =>
      snapshot(project, [job(), job({ id: 'job-2', subjectId: 'sub-002' })], {
        logTail: [
          {
            id: 'log-info',
            runId: 'run-1',
            jobId: 'job-1',
            at: 100,
            level: 'INFO',
            line: 'routine progress',
          },
          {
            id: 'log-warn',
            runId: 'run-1',
            jobId: 'job-1',
            at: 110,
            level: 'WARN',
            line: 'check this warning',
          },
          {
            id: 'log-error',
            runId: 'run-1',
            jobId: 'job-1',
            at: 120,
            level: 'ERROR',
            line: 'Review the workflow failure.',
          },
          {
            id: 'log-other-job',
            runId: 'run-1',
            jobId: 'job-2',
            at: 130,
            level: 'ERROR',
            line: 'other job failure',
          },
        ],
      }),
    )
    const stream = await screen.findByTestId('log-stream')
    expect(await screen.findByText('routine progress')).toBeInTheDocument()
    expect(screen.getByText('check this warning')).toBeInTheDocument()
    expect(screen.getByText('Review the workflow failure.')).toBeInTheDocument()
    expect(screen.getByText('other job failure')).toBeInTheDocument()
    Object.defineProperty(stream, 'scrollHeight', {
      value: 1000,
      configurable: true,
    })
    Object.defineProperty(stream, 'clientHeight', {
      value: 100,
      configurable: true,
    })
    Object.defineProperty(stream, 'scrollTop', {
      value: 800,
      writable: true,
      configurable: true,
    })
    fireEvent.scroll(stream)
    // The header chip and the stream footer both state the pause.
    expect(screen.getByRole('status', { name: /^Paused, / })).toHaveTextContent(
      'Paused',
    )
    const footer = stream.parentElement?.querySelector('footer')
    expect(footer).toHaveTextContent('Paused')
    fireEvent.click(screen.getByRole('radio', { name: 'Warn' }))
    expect(screen.queryByText('routine progress')).not.toBeInTheDocument()
    expect(stream.scrollTop).toBe(800)
    fireEvent.click(screen.getByRole('radio', { name: 'Error' }))
    expect(screen.queryByText('check this warning')).not.toBeInTheDocument()
    expect(stream.scrollTop).toBe(800)
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    // The shown run has no active job, so following it is only at the latest.
    expect(screen.getByText('At latest')).toBeInTheDocument()
    // Following is the default, so the footer says nothing about it.
    expect(footer).not.toHaveTextContent(/Paused|Tailing/i)
    expect(stream.scrollTop).toBe(1000)

    stream.scrollTop = 870
    fireEvent.scroll(stream)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('keeps following once the bounded tail is full and lines are evicted', async () => {
    const api = createMockApi()
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    const fullTail = Array.from({ length: 2_000 }, (_, index) => ({
      id: `log-${index}`,
      runId: 'run-1',
      jobId: 'job-1',
      at: 100 + index,
      level: 'INFO' as const,
      line: `line ${index}`,
    }))
    const { result } = await renderScreen(
      (project) => snapshot(project, [job()], { logTail: fullTail }),
      api,
    )
    expect(await screen.findByText('line 1999')).toBeInTheDocument()
    const stream = screen.getByTestId('log-stream')
    let scrollHeight = 5_000
    Object.defineProperty(stream, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    })
    Object.defineProperty(stream, 'clientHeight', {
      value: 100,
      configurable: true,
    })
    Object.defineProperty(stream, 'scrollTop', {
      value: 4_900,
      writable: true,
      configurable: true,
    })
    expect(stream).toHaveStyle({ overflowAnchor: 'none' })

    scrollHeight = 5_020
    await act(async () => {
      publish?.({
        kind: 'log',
        log: {
          id: 'log-2000',
          runId: 'run-1',
          jobId: 'job-1',
          at: 2_100,
          level: 'INFO',
          line: 'line 2000',
        },
        projectId: result.project.projectId,
        projectEpoch: result.project.epoch,
        sidecarGeneration: 1,
        sequence: 5,
        runId: 'run-1',
        at: 2_100,
      })
    })

    expect(await screen.findByText('line 2000')).toBeInTheDocument()
    expect(screen.queryByText('line 0')).toBeNull()
    expect(stream.scrollTop).toBe(5_020)
    expect(screen.getByText('At latest')).toBeInTheDocument()
    // Rendering 2,000 tail lines twice takes about 2 s alone and more under
    // the parallel full suite, so the default 5 s bound is too tight.
  }, 20_000)

  it('renders unscoped durable log lines without inventing job metadata', async () => {
    await renderScreen((project) =>
      snapshot(project, [], {
        logTail: [
          {
            id: 'orphan-log',
            runId: 'run-orphan',
            jobId: 'job-orphan',
            at: 125,
            level: 'INFO',
            line: 'retained after job pruning',
          },
        ],
      }),
    )

    expect(
      await screen.findByText('retained after job pruning'),
    ).toBeInTheDocument()
    expect(screen.getAllByText('unattributed')).toHaveLength(1)
    expect(screen.queryByText('job job-orphan')).toBeNull()
    expect(screen.queryByText('run run-orphan')).toBeNull()
    expect(
      screen.getByTitle('Job job-orphan; run run-orphan'),
    ).toBeInTheDocument()
    // The footer counts the lines without naming the scope.
    expect(screen.getByText('1 line, Info and above')).toBeInTheDocument()
    expect(screen.queryByText(/^scope:/)).toBeNull()
  })

  it('refreshes a verified manifest and reports a subsequent read failure', async () => {
    const api = createMockApi()
    const originalForRun = api.manifest.forRun
    const forRun = vi
      .spyOn(api.manifest, 'forRun')
      .mockImplementationOnce(async (request) => {
        const manifest = await originalForRun(request)
        return {
          ...manifest,
          git: { ...manifest.git, dirty: true },
        }
      })
      .mockRejectedValueOnce(new Error('manifest store offline'))
    const refresh = vi.fn()
    await renderScreen((project) => snapshot(project, [job()]), api, {
      refresh,
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Run details' }))
    expect(await screen.findByText('8a8c2d3 (dirty)')).toBeInTheDocument()
    // The mock manifest records no selected subset.
    expect(
      screen.getByText('Scope', { selector: 'dt' }).nextElementSibling,
    ).toHaveTextContent(/^Not recorded$/)
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh run manifest' }),
    )

    expect(
      await screen.findByText('Could not load the manifest.'),
    ).toBeInTheDocument()
    expect(screen.getByText('manifest store offline')).toBeInTheDocument()
    expect(forRun).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    // One selected subject must not read "Scope 1 subjects".
    [['sub-001'], '1 subject'],
    [['sub-001', 'sub-002'], '2 subjects'],
    [[], '0 subjects'],
    // A manifest that records no selected subset read "Scope - subjects".
    [null, 'Not recorded'],
  ] as const)(
    'states the Run details scope of the selected subset %j as %j',
    async (subjectIds, label) => {
      const api = createMockApi()
      const originalForRun = api.manifest.forRun
      vi.spyOn(api.manifest, 'forRun').mockImplementation(async (request) => {
        const manifest = await originalForRun(request)
        return subjectIds === null
          ? manifest
          : {
              ...manifest,
              selectedSubset: { subjectIds: [...subjectIds], sha256: 'a' },
            }
      })
      await renderScreen((project) => snapshot(project, [job()]), api)

      fireEvent.click(
        await screen.findByRole('button', { name: 'Run details' }),
      )
      const scope = await screen.findByText('Scope', { selector: 'dt' })
      await waitFor(() =>
        expect(scope.nextElementSibling).toHaveTextContent(label),
      )
      expect(scope.nextElementSibling?.textContent).toBe(label)
    },
  )

  it('rejects a manifest response for a different run', async () => {
    const api = createMockApi()
    const originalForRun = api.manifest.forRun
    const forRun = vi
      .spyOn(api.manifest, 'forRun')
      .mockImplementation(async (request) => ({
        ...(await originalForRun(request)),
        runId: 'run-from-another-request',
      }))
    await renderScreen((project) => snapshot(project, [job()]), api)

    await waitFor(() => expect(forRun).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
    expect(screen.getByText('Loading the manifest...')).toBeInTheDocument()
    expect(screen.queryByText('run-from-another-request')).toBeNull()
  })

  it('retries a failed node through retryWorkflow, never runWorkflow', async () => {
    const api = createMockApi()
    const retry = vi.spyOn(api.pipeline, 'retryWorkflow')
    const direct = vi.spyOn(api.pipeline, 'runWorkflow')
    await renderScreen((project) => snapshot(project, [job()]), api)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    expect(retry.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-1',
      nodeIds: ['node-1'],
      includeCancelled: false,
      cleanIncomplete: false,
    })
    expect(direct).not.toHaveBeenCalled()
  })

  it('offers no retry of a job whose stage and subject a later run scheduled again', async () => {
    // The Run list reaches superseded runs, whose failed and canceled jobs must
    // not offer a retry that would rerun settled work from the older run's
    // cohort.
    const api = createMockApi()
    const retry = vi.spyOn(api.pipeline, 'retryWorkflow')
    await renderScreen(
      (project) =>
        snapshot(
          project,
          [
            job({
              id: 'job-old-failed',
              runId: 'run-old',
              nodeId: 'node-old-recon',
              subjectId: 'sub-911',
              startedAt: 100,
              endedAt: 200,
            }),
            job({
              id: 'job-old-canceled',
              runId: 'run-old',
              nodeId: 'node-old-final',
              status: 'cancelled',
              stepKey: 'final',
              subjectId: null,
              exitCode: null,
              startedAt: 150,
              endedAt: 210,
            }),
            // Another subject's failure in the old run was never scheduled
            // again, so it keeps its retry.
            job({
              id: 'job-old-other',
              runId: 'run-old',
              nodeId: 'node-old-other',
              subjectId: 'sub-912',
              startedAt: 120,
              endedAt: 205,
            }),
            job({
              id: 'job-new-recon',
              runId: 'run-new',
              nodeId: 'node-new-recon',
              status: 'done',
              exitCode: 0,
              subjectId: 'sub-911',
              startedAt: 1_000,
              endedAt: 1_100,
            }),
            job({
              id: 'job-new-final',
              runId: 'run-new',
              nodeId: 'node-new-final',
              status: 'done',
              exitCode: 0,
              stepKey: 'final',
              subjectId: null,
              startedAt: 1_200,
              endedAt: 1_300,
            }),
            // A dry run plans the same node without scheduling it.
            job({
              id: 'job-plan-other',
              runId: 'run-plan',
              nodeId: 'node-plan-other',
              status: 'planned',
              dryRun: true,
              subjectId: 'sub-912',
              startedAt: null,
              endedAt: null,
              plannedAt: 2_000,
              exitCode: null,
            }),
          ],
          {
            runs: [
              run(project, {
                runId: 'run-old',
                status: 'failed',
                dryRun: false,
                startedAt: 100,
                endedAt: 210,
              }),
              run(project, {
                runId: 'run-new',
                status: 'done',
                dryRun: false,
                startedAt: 1_000,
                endedAt: 1_300,
              }),
              run(project, {
                runId: 'run-plan',
                status: 'planned',
                dryRun: true,
                startedAt: 2_000,
                endedAt: 2_000,
              }),
            ],
            logTail: [],
          },
        ),
      api,
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    fireEvent.change(picker, { target: { value: 'run-old' } })
    const controls = screen.getByRole('complementary', { name: 'Controls' })

    fireEvent.click(
      within(rail).getByRole('button', {
        name: /^sub-911, Reconstruction, Failed/,
      }),
    )
    const reconReason = `A later run, started ${runTimestampLabel(1_000)}, scheduled Reconstruction for sub-911 again, so this older job cannot be retried.`
    const retryFailed = within(controls).getByRole('button', {
      name: 'Retry job',
    })
    expect(retryFailed).toBeDisabled()
    expect(retryFailed).toHaveAttribute('title', reconReason)
    expect(within(controls).getByText(reconReason)).toBeInTheDocument()
    fireEvent.click(retryFailed)

    fireEvent.click(
      within(rail).getByRole('button', {
        name: /^Cohort, R analysis, Canceled/,
      }),
    )
    const retryCanceled = within(controls).getByRole('button', {
      name: 'Retry job',
    })
    expect(retryCanceled).toBeDisabled()
    expect(
      within(controls).getByText(
        `A later run, started ${runTimestampLabel(1_000)}, scheduled R analysis for the cohort again, so this older job cannot be retried.`,
      ),
    ).toBeInTheDocument()

    fireEvent.click(within(rail).getByRole('button', { name: /^sub-912,/ }))
    const retryOther = within(controls).getByRole('button', {
      name: 'Retry job',
    })
    expect(retryOther).toBeEnabled()
    expect(retryOther).not.toHaveAttribute('title')
    expect(within(controls).queryByText(/cannot be retried/)).toBeNull()
    fireEvent.click(retryOther)
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    expect(retry.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-old',
      nodeIds: ['node-old-other'],
    })
  })

  it('gives a superseded done job no retry reason', async () => {
    // A done job never had a retry, so a later run of its stage and subject
    // adds no hint, and the panel offers no retry at all.
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-old-done',
            runId: 'run-old',
            nodeId: 'node-old-recon',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-911',
            startedAt: 100,
            endedAt: 200,
          }),
          job({
            id: 'job-new-done',
            runId: 'run-new',
            nodeId: 'node-new-recon',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-911',
            startedAt: 1_000,
            endedAt: 1_100,
          }),
        ],
        {
          runs: [
            run(project, {
              runId: 'run-old',
              status: 'done',
              dryRun: false,
              startedAt: 100,
              endedAt: 200,
            }),
            run(project, {
              runId: 'run-new',
              status: 'done',
              dryRun: false,
              startedAt: 1_000,
              endedAt: 1_100,
            }),
          ],
          logTail: [],
        },
      ),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    fireEvent.change(picker, { target: { value: 'run-old' } })
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    // The old run's job is selected, and its ordinary run adds no sentence.
    expect(
      within(rail).getByRole('button', { name: /^sub-911,/, pressed: true }),
    ).toBeInTheDocument()
    expect(
      within(controls).getByText(fullText('sub-911 / Reconstruction')),
    ).toBeInTheDocument()
    expect(within(controls).queryByText(/^This job belongs/)).toBeNull()
    expect(
      within(controls).queryByRole('button', { name: /Retry/ }),
    ).not.toBeInTheDocument()
    expect(within(controls).queryByText(/cannot be retried/)).toBeNull()
  })

  it('offers Review again for PLAN_STALE and freshly repeats the same node retry', async () => {
    const api = createMockApi()
    const originalRetry = api.pipeline.retryWorkflow
    let rejectFinalOnce = true
    const retry = vi
      .spyOn(api.pipeline, 'retryWorkflow')
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
          throw new PlanStaleError()
        }
        return originalRetry(request)
      })
    await renderScreen((project) => snapshot(project, [job()]), api, {}, true)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    const reviewAgain = await screen.findByRole('button', {
      name: 'Review again',
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Review the workflow plan again because the approved plan changed.',
    )
    const firstAttempt = retry.mock.calls.map(([request]) => request)
    expect(firstAttempt.some((request) => request.approvedPlan)).toBe(true)

    fireEvent.click(reviewAgain)

    await waitFor(() =>
      expect(
        retry.mock.calls.filter(([request]) => request.approvedPlan),
      ).toHaveLength(2),
    )
    for (const [request] of retry.mock.calls) {
      expect(request).toMatchObject({
        runId: 'run-1',
        nodeIds: ['node-1'],
        includeCancelled: false,
        cleanIncomplete: false,
      })
    }
    expect(
      screen.queryByRole('button', { name: 'Review again' }),
    ).not.toBeInTheDocument()
    expect(
      await screen.findByText(
        /Dry run only: planned \d+ commands? and executed nothing\./,
      ),
    ).toBeInTheDocument()
  })

  it('offers full-cohort reconstruction normalization from a blocked retry outcome', async () => {
    const api = createMockApi()
    const retry = vi
      .spyOn(api.pipeline, 'retryWorkflow')
      .mockResolvedValueOnce(blockedNormalizationOutcome())
    const plan = vi.spyOn(api.pipeline, 'planWorkflow')
    const run = vi.spyOn(api.pipeline, 'runWorkflow')
    await renderScreen((project) => snapshot(project, [job()]), api, {}, true)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))

    const blockedActions = await screen.findByRole('group', {
      name: 'Blocked workflow actions',
    })
    fireEvent.click(
      within(blockedActions).getByRole('button', {
        name: 'Normalize full reconstruction cohort',
      }),
    )

    expect(retry).toHaveBeenCalled()
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1))
    expect(plan.mock.calls[0]?.[0].intent).toEqual({
      kind: 'stage',
      stepKey: 'recon',
      target: { mode: 'all' },
    })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run.mock.calls[0]?.[0].intent).toEqual({
      kind: 'stage',
      stepKey: 'recon',
      target: { mode: 'all' },
    })
  })

  it('keeps the blockers of a blocked retry outcome reachable from the Logs notice', async () => {
    const api = createMockApi()
    vi.spyOn(api.pipeline, 'retryWorkflow').mockResolvedValueOnce(
      blockedRegistryOutcome(),
    )
    await renderScreen((project) => snapshot(project, [job()]), api, {}, true)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))

    const actions = await screen.findByRole('group', {
      name: 'Blocked workflow actions',
    })
    fireEvent.click(
      within(actions).getByRole('button', { name: 'View blockers' }),
    )
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(
        'Register every subject before retrying because sub-001 is unregistered.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Open Registry' }),
    )
    expect(screen.getByTestId('route-probe')).toHaveTextContent('registry')
  })

  it('reflows all panes before narrow controls can displace selected-job actions', async () => {
    const callbacks: ResizeObserverCallback[] = []
    const disconnect = vi.fn()
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        disconnect()
      }
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    const { view } = await renderScreen((project) => snapshot(project, [job()]))

    const workspace = await screen.findByTestId('logs-workspace')
    expect(workspace).toHaveAttribute('data-layout', 'three-pane')

    const resizeWorkspace = (width: number): void => {
      const entry = {
        target: workspace,
        contentRect: { width },
      } as unknown as ResizeObserverEntry
      callbacks.forEach((callback) => callback([entry], {} as ResizeObserver))
    }
    act(() => {
      resizeWorkspace(860)
    })

    expect(workspace).toHaveAttribute('data-layout', 'stacked-controls')
    expect(workspace).toHaveAttribute('data-wide-min-px', '900')
    // The stacked workspace scrolls, so the lower panels keep their full
    // height below a log view that never drops under a readable size.
    expect(workspace).toHaveStyle({
      gridTemplateAreas: '"jobs stream" "controls controls"',
      gridTemplateColumns: 'minmax(190px, 230px) minmax(0, 1fr)',
      gridTemplateRows: 'max(240px, calc(100% - 96px)) max-content',
      overflow: 'auto',
    })

    const jobs = screen.getByRole('complementary', { name: 'Jobs' })
    const stream = screen.getByRole('region', { name: 'Log stream' })
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    expect(jobs).toHaveAttribute('data-layout-region', 'jobs')
    expect(stream).toHaveAttribute('data-layout-region', 'stream')
    expect(controls).toHaveAttribute('data-layout-region', 'controls')
    expect(controls).toHaveStyle({
      display: 'grid',
      minWidth: '0',
      overflow: 'visible',
    })
    expect(controls.style.maxHeight).toBe('')

    const actions = await screen.findByRole('group', {
      name: 'Selected job actions',
    })
    const copy = within(actions).getByRole('button', {
      name: 'Copy command',
    })
    const retry = within(actions).getByRole('button', {
      name: 'Retry job',
    })

    // The retry keeps its content width, and the copy icon sits at the
    // trailing edge of the Command label row right above the command.
    expect(actions).toHaveStyle({ display: 'flex', flexDirection: 'column' })
    expect(actions).toHaveAttribute(
      'data-layout-region',
      'selected-job-actions',
    )
    expect(controls).toContainElement(actions)
    expect(actions).toAppearBefore(screen.getByLabelText('Job command'))
    expect([...actions.querySelectorAll('button')]).toEqual([retry, copy])
    expect(retry).toHaveStyle({ alignSelf: 'flex-start' })
    expect(copy).toHaveAttribute('title', 'Copy command')
    const commandRow = within(actions).getByText('Command').parentElement
    expect(commandRow).toContainElement(copy)
    expect(commandRow).toHaveStyle({ justifyContent: 'space-between' })
    expect(
      screen.getByRole('heading', { name: 'Selected job' }),
    ).toAppearBefore(screen.getByRole('button', { name: 'Run details' }))
    expect(
      screen.queryByRole('heading', { name: 'Level threshold' }),
    ).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'Selected job' }).parentElement
        ?.parentElement,
    ).toHaveStyle({ flexShrink: '0' })
    expect(
      screen.getByRole('button', { name: 'Run details' }).parentElement
        ?.parentElement?.parentElement,
    ).toHaveStyle({ flexShrink: '0' })
    expect(
      screen.getByRole('heading', { name: 'Debug bundle' }).parentElement
        ?.parentElement,
    ).toHaveStyle({ flexShrink: '0' })

    copy.focus()
    expect(copy).toHaveFocus()
    retry.focus()
    expect(retry).toHaveFocus()

    act(() => {
      resizeWorkspace(960)
    })
    expect(workspace).toHaveAttribute('data-layout', 'three-pane')
    expect(controls).toHaveStyle({ display: 'flex' })
    expect(controls).toContainElement(actions)

    view.unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('retries a canceled node without borrowed run acknowledgements', async () => {
    const api = createMockApi()
    const pending =
      deferred<Awaited<ReturnType<typeof api.pipeline.retryWorkflow>>>()
    const retry = vi
      .spyOn(api.pipeline, 'retryWorkflow')
      .mockReturnValue(pending.promise)
    await renderScreen(
      (project) =>
        snapshot(project, [job({ status: 'cancelled' })], { runs: [] }),
      api,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    // Nothing starts before a plan is approved, so the pending preview is
    // planning, not retrying.
    expect(
      await screen.findByRole('button', { name: 'Planning the retry...' }),
    ).toBeDisabled()
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    expect(retry.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-1',
      includeCancelled: true,
      acknowledgements: {
        includeDeferredAndUnreviewedQc: false,
        acknowledgeMemoryAdvisory: false,
      },
    })

    await act(async () => {
      pending.reject('retry transport closed')
      await Promise.resolve()
    })
    expect(await screen.findByText('Retry the job.')).toBeInTheDocument()
    expect(screen.getByText('The action failed.')).toBeInTheDocument()
  })

  it('requires explicit categories, redaction consent, and a destination grant', async () => {
    const api = createMockApi()
    vi.spyOn(api.manifest, 'previewDebug').mockResolvedValue(
      preview({
        categories: [
          {
            id: 'logs',
            label: 'Runtime logs',
            fileCount: 2,
            estimatedBytes: 100,
            redactions: ['subject identifiers'],
            truncated: false,
          },
          {
            id: 'environment',
            label: 'Environment summary',
            fileCount: 1,
            estimatedBytes: 2 * 1024,
            redactions: [],
            truncated: false,
          },
          {
            id: 'configuration',
            label: 'Configuration',
            fileCount: 3,
            estimatedBytes: 2 * 1024 ** 2,
            redactions: ['paths'],
            truncated: true,
          },
          {
            id: 'crash',
            label: 'Crash artifacts',
            fileCount: 2,
            estimatedBytes: 2 * 1024 ** 3,
            redactions: [],
            truncated: false,
          },
        ],
        totalFiles: 8,
        estimatedBytes: 2 * 1024 ** 3,
        truncated: true,
      }),
    )
    const chooseSavePath = vi
      .spyOn(api.fs, 'chooseSavePath')
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        destinationId: 'destination-1',
        displayPath: 'debug.zip',
      })
    const bundle = vi
      .spyOn(api.manifest, 'bundleDebug')
      .mockRejectedValueOnce(
        new Error('Retry because the archive write failed.'),
      )
      .mockResolvedValue({
        artifactId: 'debug:run-1',
        displayPath: 'debug.zip',
      })
    const reveal = vi
      .spyOn(api.artifact, 'reveal')
      .mockRejectedValueOnce('Retry because the reveal transport closed.')
      .mockResolvedValue(undefined)
    const { result } = await renderScreen(
      (project) => snapshot(project, [job()]),
      api,
    )

    const previewButton = await screen.findByRole('button', {
      name: 'Export debug bundle...',
    })
    await waitFor(() => expect(previewButton).toBeEnabled())
    fireEvent.click(previewButton)
    const create = await screen.findByRole('button', {
      name: 'Choose destination and create',
    })
    expect(create).toBeDisabled()
    expect(screen.getByText(/2\.0 KiB/)).toBeInTheDocument()
    expect(screen.getByText(/2\.0 MiB, preview truncated/)).toBeInTheDocument()
    expect(screen.getAllByText(/2\.0 GiB/)).toHaveLength(2)
    expect(
      screen.getByText(/Preview total: 8 files.*truncated/),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /Runtime logs/i }))
    expect(create).toBeEnabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Runtime logs/i }))
    expect(create).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /Runtime logs/i }))
    fireEvent.click(create)

    await waitFor(() => expect(chooseSavePath).toHaveBeenCalledTimes(1))
    expect(bundle).not.toHaveBeenCalled()
    expect(create).toBeEnabled()
    fireEvent.click(create)
    expect(
      await screen.findAllByText('Retry because the archive write failed.'),
    ).toHaveLength(2)
    expect(create).toBeEnabled()
    fireEvent.click(create)

    await waitFor(() => expect(bundle).toHaveBeenCalledTimes(2))
    expect(chooseSavePath).toHaveBeenLastCalledWith({
      purpose: 'debug-bundle',
      project: result.project,
      defaultPath: 'supraspina-run-1-debug.zip',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    })
    expect(bundle).toHaveBeenLastCalledWith({
      project: result.project,
      runId: 'run-1',
      categoryIds: ['logs'],
      destinationId: 'destination-1',
      consent: true,
      redaction: 'required',
    })
    expect(
      await screen.findByText(
        fullText('Created the diagnostic bundle at debug.zip.'),
      ),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reveal bundle' }))
    expect(
      await screen.findByText('Retry revealing the debug bundle.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal bundle' }))
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(2))
    expect(reveal).toHaveBeenLastCalledWith({
      project: result.project,
      artifactId: 'debug:run-1',
    })
  })

  it('counts one debug file as a file, in each category and the total', async () => {
    // A one-file category and total must not read "1 files".
    const api = createMockApi()
    vi.spyOn(api.manifest, 'previewDebug').mockResolvedValue(
      preview({
        categories: [
          {
            id: 'environment',
            label: 'Environment summary',
            fileCount: 1,
            estimatedBytes: 100,
            redactions: [],
            truncated: false,
          },
          {
            id: 'crash',
            label: 'Crash artifacts',
            fileCount: 0,
            estimatedBytes: 0,
            redactions: [],
            truncated: false,
          },
        ],
        totalFiles: 1,
        estimatedBytes: 100,
      }),
    )
    await renderScreen((project) => snapshot(project, [job()]), api)

    const previewButton = await screen.findByRole('button', {
      name: 'Export debug bundle...',
    })
    await waitFor(() => expect(previewButton).toBeEnabled())
    fireEvent.click(previewButton)
    const dialog = await screen.findByRole('dialog', {
      name: 'Confirm creation of a redacted debug bundle',
    })
    expect(within(dialog).getByText('1 file, 100 B')).toBeInTheDocument()
    expect(within(dialog).getByText('0 files, 0 B')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Preview total: 1 file, 100 B.'),
    ).toBeInTheDocument()
    expect(within(dialog).queryByText(/\b1 files\b/)).toBeNull()
  })

  it('recovers from invalid debug previews and allows an empty preview to close', async () => {
    const api = createMockApi()
    const previewDebug = vi
      .spyOn(api.manifest, 'previewDebug')
      .mockResolvedValueOnce(preview({ runId: 'another-run' }))
      .mockRejectedValueOnce('preview transport closed')
      .mockResolvedValue(preview())
    await renderScreen((project) => snapshot(project, [job()]), api)

    const previewButton = await screen.findByRole('button', {
      name: 'Export debug bundle...',
    })
    await waitFor(() => expect(previewButton).toBeEnabled())
    fireEvent.click(previewButton)
    expect(
      await screen.findByText('Reload the debug preview for this run.'),
    ).toBeInTheDocument()

    fireEvent.click(previewButton)
    expect(
      await screen.findByText('Retry previewing the debug bundle.'),
    ).toBeInTheDocument()

    fireEvent.click(previewButton)
    expect(
      await screen.findByText('This run has no exportable debug categories.'),
    ).toBeInTheDocument()
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm creation of a redacted debug bundle',
    })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(previewButton)
    expect(
      await screen.findByRole('button', { name: 'Cancel' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(previewDebug).toHaveBeenCalledTimes(4)
  })
})

describe('LogsScreen node retry review', () => {
  /** A bound one-node retry plan, as the sidecar previews it. */
  function boundRetry(): WorkflowResult {
    const summary: WorkflowSummary = {
      planned: 1,
      started: 0,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: '1 node is planned.',
    }
    return {
      runId: null,
      disposition: 'planned',
      plan: {
        planId: 'run-abcdef123456',
        digest: 'a'.repeat(64),
        configDigest: 'b'.repeat(64),
        qcDigest: 'c'.repeat(64),
        registryDigest: 'd'.repeat(64),
        environmentDigest: 'e'.repeat(64),
        analysisCohort: { subjectIds: ['sub-001'], sha256: 'analysis' },
        selectedSubset: { subjectIds: ['sub-001'], sha256: 'selected' },
        nodes: [
          {
            nodeId: 'node-1',
            stepKey: 'recon',
            scope: 'subject',
            subjectId: 'sub-001',
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
    }
  }

  /** Logs under the real plan review, with Allow live runs off. */
  async function renderWithReview(
    api: SupraspinaApi,
    status: Job['status'],
    { dryRun }: { dryRun: boolean },
    probe: ReactNode = null,
  ): Promise<ProjectOpenResult['project']> {
    window.supraspina = api
    const cfg = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/projects/logs' },
      runtime: { ...DEFAULT_PROJECT_CONFIG.runtime, dryRun },
    }
    const result = await api.project.create({
      at: '/projects/logs',
      cfg,
      epoch: 1,
    })
    vi.spyOn(api.runtime, 'bootstrap').mockImplementation(async () =>
      snapshot(result.project, [job({ status })]),
    )
    render(
      <AppProvider>
        <Bootstrap result={result}>
          <WorkflowReviewProvider>
            <RuntimeProvider>
              <LogsScreen />
              {probe}
            </RuntimeProvider>
          </WorkflowReviewProvider>
        </Bootstrap>
      </AppProvider>,
    )
    return result.project
  }

  it.each(['failed', 'interrupted', 'cancelled'] as const)(
    "names the %s job's own retry beside the read-only approval",
    async (status) => {
      // The review names the job's own retry button.
      const label = 'Retry job'
      const api = createMockApi()
      const retry = vi
        .spyOn(api.pipeline, 'retryWorkflow')
        .mockResolvedValue(boundRetry())
      await renderWithReview(api, status, { dryRun: false })

      fireEvent.click(await screen.findByRole('button', { name: label }))
      const dialog = await screen.findByRole('dialog', {
        name: 'Review the exact retry plan.',
      })
      expect(
        within(dialog).getByRole('button', { name: 'Authorize retry' }),
      ).toHaveAccessibleDescription(
        `Authorize retry is unavailable because Allow live runs is off. To run this plan, turn on Allow live runs in Runs > Execution controls or in Settings, save the project, then choose ${label} again.`,
      )
      expect(retry).toHaveBeenCalledOnce()
      expect(retry.mock.calls[0]?.[0]).toMatchObject({
        nodeIds: ['node-1'],
        includeCancelled: status === 'cancelled',
        previewOnly: true,
      })

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(retry).toHaveBeenCalledOnce()
    },
  )

  it('names the normalization button beside its read-only approval', async () => {
    // The review must name the button the operator pressed, not "start the run
    // again".
    const api = createMockApi()
    vi.spyOn(api.pipeline, 'retryWorkflow').mockResolvedValue(
      blockedNormalizationOutcome(),
    )
    vi.spyOn(api.pipeline, 'planWorkflow').mockResolvedValue(boundRetry())
    await renderWithReview(api, 'failed', { dryRun: false })

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    const blockedActions = await screen.findByRole('group', {
      name: 'Blocked workflow actions',
    })
    fireEvent.click(
      within(blockedActions).getByRole('button', {
        name: 'Normalize full reconstruction cohort',
      }),
    )
    const dialog = await screen.findByRole('dialog')
    const authorize = within(dialog).getByRole('button', {
      name: /^Authorize/,
    })
    expect(authorize).toBeDisabled()
    expect(authorize).toHaveAccessibleDescription(
      /then choose Normalize full reconstruction cohort again\.$/,
    )
  })

  /** The Selected job's retry button, also behind an open review. */
  function retryButton(): HTMLElement {
    const actions = screen.getByRole('group', {
      name: 'Selected job actions',
      hidden: true,
    })
    return within(actions).getByRole('button', {
      name: /Retry|Planning/,
      hidden: true,
    })
  }

  it('states planning until the plan opens and keeps the plain label while it is open', async () => {
    // Behind the read-only review nothing has started or can start, so the
    // button must not read "Retrying...".
    const api = createMockApi()
    const preview = deferred<WorkflowResult>()
    vi.spyOn(api.pipeline, 'retryWorkflow').mockReturnValue(preview.promise)
    await renderWithReview(api, 'cancelled', { dryRun: false })

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    await waitFor(() =>
      expect(retryButton()).toHaveAccessibleName('Planning the retry...'),
    )
    expect(retryButton()).toBeDisabled()

    await act(async () => {
      preview.resolve(boundRetry())
      await Promise.resolve()
    })
    const dialog = await screen.findByRole('dialog', {
      name: 'Review the exact retry plan.',
    })
    expect(retryButton()).toHaveAccessibleName('Retry job')
    expect(screen.queryByText('Retrying...')).toBeNull()
    expect(screen.queryByText('Planning the retry...')).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(retryButton()).toHaveAccessibleName('Retry job')
    expect(retryButton()).toBeEnabled()
    expect(screen.queryByText('The action failed.')).toBeNull()
  })

  it('publishes its planning line to the dock and Runs while it plans', async () => {
    // Without a shared pending plan the run dock and Runs would show nothing
    // while a Logs retry plans and would leave their launch controls free.
    function PendingPlanProbe(): ReactNode {
      const { pendingPlan } = useApp()
      return (
        <output data-testid="pending-plan">
          {pendingPlan
            ? `${pendingPlan.label} | ${pendingPlan.waitReason}`
            : 'none'}
        </output>
      )
    }
    const api = createMockApi()
    const preview = deferred<WorkflowResult>()
    const launch = deferred<WorkflowResult>()
    vi.spyOn(api.pipeline, 'retryWorkflow')
      .mockReturnValueOnce(preview.promise)
      .mockReturnValueOnce(launch.promise)
    await renderWithReview(
      api,
      'failed',
      { dryRun: true },
      <PendingPlanProbe />,
    )
    const pending = screen.getByTestId('pending-plan')
    expect(pending).toHaveTextContent('none')

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    await waitFor(() =>
      expect(pending).toHaveTextContent(
        'Planning the retry... | Supraspina is planning the retry.',
      ),
    )

    // The open review holds the other launches; the line is released.
    await act(async () => {
      preview.resolve(boundRetry())
      await Promise.resolve()
    })
    const dialog = await screen.findByRole('dialog', {
      name: 'Review the exact retry plan.',
    })
    expect(pending).toHaveTextContent('none')

    // Approval holds the line again until the launch settles.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept plan' }))
    await waitFor(() =>
      expect(pending).toHaveTextContent('Planning the retry...'),
    )
    await act(async () => {
      launch.resolve(boundRetry())
      await Promise.resolve()
    })
    await waitFor(() => expect(pending).toHaveTextContent('none'))
  })

  it('leaves the Runs failure it follows while its retry plans and closes', async () => {
    // The retry's planning line must not clear the Runs feedback: a closed
    // review would remove the Runs failure alert while Resume still offers the
    // failed run, and a recovery would never give way to its notice.
    function RunsFailureProbe(): ReactNode {
      const { runsFeedback, setRunsFeedback } = useApp()
      useLayoutEffect(() => {
        setRunsFeedback((prev) => ({
          ...prev,
          error: { error: new Error('Run run-1 failed.'), reviewAgain: null },
        }))
      }, [setRunsFeedback])
      return (
        <output data-testid="runs-failure">
          {runsFeedback.error?.error.message ?? 'none'}
        </output>
      )
    }
    const api = createMockApi()
    const preview = deferred<WorkflowResult>()
    vi.spyOn(api.pipeline, 'retryWorkflow').mockReturnValue(preview.promise)
    await renderWithReview(
      api,
      'failed',
      { dryRun: false },
      <RunsFailureProbe />,
    )
    const failure = screen.getByTestId('runs-failure')
    expect(failure).toHaveTextContent('Run run-1 failed.')

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    await waitFor(() =>
      expect(retryButton()).toHaveAccessibleName('Planning the retry...'),
    )
    expect(failure).toHaveTextContent('Run run-1 failed.')
    await act(async () => {
      preview.resolve(boundRetry())
      await Promise.resolve()
    })
    const dialog = await screen.findByRole('dialog', {
      name: 'Review the exact retry plan.',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(failure).toHaveTextContent('Run run-1 failed.')
  })

  it('waits for a plan another launch is preparing and says which', async () => {
    let publish: ((pending: boolean) => void) | null = null
    function OtherLaunch(): ReactNode {
      const { trackPlan } = useApp()
      useLayoutEffect(() => {
        publish = trackPlan({
          label: 'Planning the workflow...',
          waitReason: 'Supraspina is planning the workflow.',
          card: null,
        })
      }, [trackPlan])
      return null
    }
    const api = createMockApi()
    await renderWithReview(api, 'failed', { dryRun: true }, <OtherLaunch />)
    const button = await screen.findByRole('button', {
      name: 'Retry job',
    })
    expect(button).toBeEnabled()

    act(() => publish?.(true))
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'title',
      'Supraspina is planning the workflow.',
    )

    act(() => publish?.(false))
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('title')
  })

  it('stays retrying from the launch until its run reaches the runtime', async () => {
    // Between "Retrying..." and the superseded state the new run's job brings,
    // the button must not briefly offer "Retry job" again.
    const api = createMockApi()
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    const launch = deferred<WorkflowResult>()
    vi.spyOn(api.pipeline, 'retryWorkflow')
      .mockResolvedValueOnce(boundRetry())
      .mockReturnValueOnce(launch.promise)
    const project = await renderWithReview(api, 'failed', { dryRun: true })

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Review the exact retry plan.',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept plan' }))
    await waitFor(() =>
      expect(retryButton()).toHaveAccessibleName('Retrying...'),
    )

    await act(async () => {
      launch.resolve({
        ...boundRetry(),
        runId: 'run-2',
        disposition: 'started',
      })
      await Promise.resolve()
    })
    // The launch settled, and the runtime has not listed the run yet.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(retryButton()).toHaveAccessibleName('Retrying...')
    expect(retryButton()).toBeDisabled()

    await act(async () => {
      publish?.({
        kind: 'job',
        job: {
          ...job({
            id: 'job-2',
            runId: 'run-2',
            status: 'queued',
            startedAt: null,
            endedAt: null,
            exitCode: null,
            plannedAt: 300,
          }),
          projectId: project.projectId,
          projectEpoch: project.epoch,
          sidecarGeneration: 1,
        },
        projectId: project.projectId,
        projectEpoch: project.epoch,
        sidecarGeneration: 1,
        sequence: 5,
        runId: 'run-2',
        at: 300,
      })
    })
    await waitFor(() => expect(retryButton()).toHaveAccessibleName('Retry job'))
    expect(retryButton()).toBeDisabled()
    expect(retryButton()).toHaveAttribute(
      'title',
      expect.stringMatching(/^A later run.*cannot be retried\.$/),
    )
  })

  it('states retrying only after the plan is approved', async () => {
    const api = createMockApi()
    const launch = deferred<WorkflowResult>()
    const retry = vi
      .spyOn(api.pipeline, 'retryWorkflow')
      .mockResolvedValueOnce(boundRetry())
      .mockReturnValueOnce(launch.promise)
    await renderWithReview(api, 'failed', { dryRun: true })

    fireEvent.click(await screen.findByRole('button', { name: 'Retry job' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Review the exact retry plan.',
    })
    expect(retryButton()).toHaveAccessibleName('Retry job')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept plan' }))
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(2))
    expect(retry.mock.calls[1]?.[0]).toMatchObject({
      nodeIds: ['node-1'],
      approvedPlan: { planId: 'run-abcdef123456' },
    })
    expect(retryButton()).toHaveAccessibleName('Retrying...')
    expect(retryButton()).toBeDisabled()

    await act(async () => {
      launch.resolve(boundRetry())
      await Promise.resolve()
    })
    await waitFor(() => expect(retryButton()).toHaveAccessibleName('Retry job'))
    expect(retryButton()).toBeEnabled()
  })
})

describe('LogsScreen contrast on the failure tint', () => {
  type Rgb = [number, number, number]
  const channels = (color: string): Rgb => {
    const parts = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/)
    if (!parts) throw new Error(`Supply an opaque rgb() color, not ${color}.`)
    return [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  }
  const contrast = (a: string, b: string): number => {
    const lum = (color: string): number => {
      const [r, g, bl] = channels(color).map((c) => {
        const v = c / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }) as Rgb
      return 0.2126 * r + 0.7152 * g + 0.0722 * bl
    }
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }
  const rgb = (hex: string): string => {
    const value = hex.replace('#', '')
    return `rgb(${[0, 2, 4]
      .map((index) => Number.parseInt(value.slice(index, index + 2), 16))
      .join(', ')})`
  }

  it('keeps the time gutter and the outcome labels at 4.5:1 on the tint in every theme', async () => {
    // In the light theme the plain grays measure 4.02:1 (time gutter) and
    // 3.89:1 (outcome labels) on the failure tint.
    const api = createMockApi()
    window.supraspina = api
    const cfg = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/projects/logs' },
    }
    const result = await api.project.create({
      at: '/projects/logs',
      cfg,
      epoch: 1,
    })
    vi.spyOn(api.runtime, 'bootstrap').mockImplementation(async () =>
      snapshot(result.project, [job()], {
        logTail: [
          {
            id: 'log-info',
            runId: 'run-1',
            jobId: 'job-1',
            at: 120,
            level: 'INFO',
            line: 'routine progress',
          },
          {
            id: 'log-error',
            runId: 'run-1',
            jobId: 'job-1',
            at: 150,
            level: 'ERROR',
            line: 'backend failure',
          },
        ],
      }),
    )
    let app: ReturnType<typeof useApp> | null = null
    function Handle(): ReactNode {
      const current = useApp()
      useLayoutEffect(() => {
        app = current
      }, [current])
      return null
    }
    render(
      <AppProvider>
        <Bootstrap result={result}>
          <RuntimeProvider>
            <Handle />
            <LogsScreen />
          </RuntimeProvider>
        </Bootstrap>
      </AppProvider>,
    )
    await screen.findByText('backend failure')
    const variants = [
      ['light', false],
      ['dark', false],
      ['light', true],
      ['dark', true],
    ] as const
    for (const [theme, highContrast] of variants) {
      act(() => app?.setTweaks({ theme, highContrast }))
      const base = THEMES[theme]
      const expected = highContrast ? highContrastTheme(base) : base
      await waitFor(() => expect(app?.t).toEqual(expected))
      const stream = screen.getByTestId('log-stream')
      const errorRow = stream.querySelector<HTMLElement>('[data-level="ERROR"]')
      const infoRow = stream.querySelector<HTMLElement>('[data-level="INFO"]')
      if (!errorRow || !infoRow) throw new Error('Render both log rows.')
      const clock = within(errorRow).getByTestId('log-line-clock')
      expect(errorRow.style.backgroundColor).toBe(rgb(expected.failedSoft))
      expect(
        contrast(clock.style.color, errorRow.style.backgroundColor),
      ).toBeGreaterThanOrEqual(4.5)
      // A routine line keeps the plain gutter gray.
      expect(within(infoRow).getByTestId('log-line-clock').style.color).toBe(
        rgb(expected.dimText),
      )
      const outcome = screen.getByRole('region', { name: 'Result' })
      expect(outcome.style.backgroundColor).toBe(rgb(expected.failedSoft))
      const labels = outcome.querySelectorAll<HTMLElement>('dt')
      expect(labels).toHaveLength(2)
      for (const label of labels) {
        expect(
          contrast(label.style.color, outcome.style.backgroundColor),
        ).toBeGreaterThanOrEqual(4.5)
        // Still quieter than the recorded reason beside it.
        expect(
          contrast(label.style.color, outcome.style.backgroundColor),
        ).toBeLessThan(
          contrast(rgb(expected.text), outcome.style.backgroundColor),
        )
      }
    }
  })
})

describe('LogsScreen status glyphs', () => {
  /** Each settled or waiting job status and the legend state it draws. */
  const LEGEND_STATES = [
    ['failed', 'failed'],
    ['blocked', 'blocked'],
    ['withheld', 'withheld'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted'],
    ['stale', 'stale'],
    ['unknown', 'stale'],
    ['done', 'done'],
    ['planned', 'planned'],
    ['waiting', 'waiting'],
    ['queued', 'queued'],
  ] as const

  /** The color an SVG glyph draws in: its stroke, or its fill when filled. */
  function glyphColor(glyph: Element): string | null {
    const stroke = glyph.getAttribute('stroke')
    return stroke && stroke !== 'none' ? stroke : glyph.getAttribute('fill')
  }

  it('draws each job row and badge with the legend glyph and tone Recent runs uses', async () => {
    // A blocked run keeps its amber prohibited sign, a canceled run its gray
    // ringed stop, and an interrupted run its bolt in the same tone.
    await renderScreen((project) =>
      snapshot(
        project,
        [
          ...LEGEND_STATES.map(([status], index) =>
            job({
              id: `job-${status}`,
              nodeId: `node-${status}`,
              status,
              subjectId: `sub-${String(index + 1).padStart(3, '0')}`,
              startedAt: 100 + index,
              endedAt: 200 + index,
            }),
          ),
          job({
            id: 'job-storage',
            nodeId: 'node-storage',
            status: 'persistence-error',
            subjectId: 'sub-099',
            startedAt: 90,
            endedAt: 190,
          }),
        ],
        { logTail: [] },
      ),
    )
    // The test renderer has no dark-scheme media query, so System is light.
    const t = THEMES.light
    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    await within(rail).findByRole('button', { name: /^sub-001,/ })
    for (const [status, state] of LEGEND_STATES) {
      const index = LEGEND_STATES.findIndex(([other]) => other === status)
      const row = within(rail).getByRole('button', {
        name: new RegExp(`^sub-${String(index + 1).padStart(3, '0')},`),
      })
      const glyphs = row.querySelectorAll('[data-glyph-shape]')
      // The badge is the row's only status mark.
      expect(glyphs, status).toHaveLength(1)
      for (const glyph of glyphs) {
        expect(glyph, status).toHaveAttribute(
          'data-glyph-shape',
          statusGlyphShape(state),
        )
        expect(glyphColor(glyph), status).toBe(statusGlyphColor(t, state))
      }
    }
    // A job whose state could not be stored draws the Recent runs warning
    // sign in amber, not the failure red.
    const storage = within(rail).getByRole('button', { name: /^sub-099,/ })
    const signs = storage.querySelectorAll('svg')
    expect(signs).toHaveLength(1)
    for (const sign of signs) {
      expect(sign).toHaveAttribute('stroke', t.warning)
    }

    // The Selected job badge draws the selected job's glyph.
    fireEvent.click(within(rail).getByRole('button', { name: /^sub-003,/ }))
    const card = screen.getByRole('heading', { name: 'Selected job' })
      .parentElement?.parentElement as HTMLElement
    const badge = within(card).getByText('Withheld')
    const glyph = badge.querySelector('[data-glyph-shape]')
    expect(glyph).toHaveAttribute('data-glyph-shape', 'pause')
    expect(glyphColor(glyph as Element)).toBe(statusGlyphColor(t, 'withheld'))
  })
})

describe('LogsScreen hand-off from the Dashboard', () => {
  /** The Dashboard, or Logs while the route is logs, with a way back. */
  function Shell(): ReactNode {
    const { route, setRoute } = useApp()
    return (
      <>
        <button type="button" onClick={() => setRoute('project')}>
          Go to Dashboard
        </button>
        <button type="button" onClick={() => setRoute('logs')}>
          Go to Logs
        </button>
        {route === 'logs' ? <LogsScreen /> : <ProjectDashboard subjects={[]} />}
      </>
    )
  }

  function manifest(
    runId: string,
    startedAt: string,
    steps: RunManifest['steps'],
  ): RunManifest {
    return {
      runId,
      startedAt,
      endedAt: startedAt.replace(':00.000Z', ':30.000Z'),
      user: 'operator',
      host: 'fixture-host',
      git: { repo: 'supraspina', sha: '', dirty: false },
      configSha256: '0'.repeat(64),
      steps,
      tools: {},
    }
  }

  it('opens Logs on a Recent runs row once, and a later visit keeps the default run', async () => {
    const api = createMockApi()
    window.supraspina = api
    const cfg = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/projects/logs' },
    }
    const result = await api.project.create({
      at: '/projects/logs',
      cfg,
      epoch: 1,
    })
    const oldAt = Date.parse('2026-09-21T20:34:00.000Z')
    const newAt = Date.parse('2026-09-23T18:35:00.000Z')
    vi.spyOn(api.runtime, 'bootstrap').mockImplementation(async () =>
      snapshot(
        result.project,
        [
          job({
            id: 'job-old-failed',
            runId: 'run-old',
            subjectId: 'sub-911',
            startedAt: oldAt,
            endedAt: oldAt + 10_000,
          }),
          job({
            id: 'job-old-blocked',
            runId: 'run-old',
            status: 'blocked',
            stepKey: 'enigma',
            subjectId: null,
            startedAt: null,
            endedAt: oldAt + 20_000,
            exitCode: null,
          }),
          job({
            id: 'job-new-done',
            runId: 'run-new',
            status: 'done',
            exitCode: 0,
            subjectId: 'sub-001',
            startedAt: newAt,
            endedAt: newAt + 10_000,
          }),
        ],
        {
          runs: [
            run(result.project, {
              runId: 'run-old',
              status: 'failed',
              dryRun: false,
              startedAt: oldAt,
              endedAt: oldAt + 30_000,
            }),
            run(result.project, {
              runId: 'run-new',
              status: 'done',
              dryRun: false,
              startedAt: newAt,
              endedAt: newAt + 30_000,
            }),
          ],
          logTail: [],
        },
      ),
    )
    vi.spyOn(api.manifest, 'list').mockResolvedValue({
      items: [
        manifest('run-new', '2026-09-23T18:35:00.000Z', [
          {
            id: 1,
            key: 'recon',
            status: 'done',
            subjects: 1,
            failed: 0,
            durationSec: 10,
          },
        ]),
        // A run blocked while planning has no job, so Logs cannot focus it.
        manifest('run-planned-blocked', '2026-09-22T09:00:00.000Z', [
          {
            id: 1,
            key: 'final',
            status: 'blocked',
            subjects: 1,
            failed: 0,
            durationSec: 0,
          },
        ]),
        manifest('run-old', '2026-09-21T20:34:00.000Z', [
          {
            id: 1,
            key: 'recon',
            status: 'failed',
            subjects: 1,
            failed: 1,
            durationSec: 10,
          },
        ]),
      ],
      nextCursor: null,
    })
    const forRun = vi.spyOn(api.manifest, 'forRun')
    render(
      <AppProvider>
        <Bootstrap result={result}>
          <RuntimeProvider>
            <Shell />
            <RouteProbe />
          </RuntimeProvider>
        </Bootstrap>
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go to Dashboard' }))

    const open = await screen.findByRole('button', {
      name: /^Open this run in Logs \(Failed, .*\. 1 failure/,
    })
    // What each row shows is unchanged, and a run with no job keeps a plain
    // row without an action.
    expect(open.closest('[role="listitem"]')).not.toBeNull()
    expect(
      screen.getByRole('listitem', { name: /^Blocked, .*R analysis/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /R analysis blocked/ }),
    ).toBeNull()
    expect(
      screen.getAllByRole('button', { name: /^Open this run in Logs/ }),
    ).toHaveLength(2)
    // A native button: it takes focus and Enter or Space activates it.
    expect(open.tagName).toBe('BUTTON')
    open.focus()
    expect(open).toHaveFocus()
    fireEvent.click(open)

    expect(screen.getByTestId('route-probe')).toHaveTextContent('logs')
    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    expect(picker).toHaveValue('run-old')
    // The row unmounts with the Dashboard, which would leave focus on the page
    // body; the Run list that names the run takes it.
    await waitFor(() => expect(picker).toHaveFocus())
    expect(
      within(rail).getByRole('button', { name: /^sub-911,/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    expect(
      within(controls).getByText(fullText('sub-911 / Reconstruction')),
    ).toBeInTheDocument()
    // The subject ID is code; the stage name beside it is prose.
    expect(within(controls).getByText('sub-911').tagName).toBe('CODE')
    await waitFor(() =>
      expect(forRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ runId: 'run-old' }),
      ),
    )

    // A later visit by the navigation opens on the default run and leaves
    // focus on the control that opened Logs.
    fireEvent.click(screen.getByRole('button', { name: 'Go to Dashboard' }))
    await screen.findByRole('button', {
      name: /^Open this run in Logs \(Failed, .*\. 1 failure/,
    })
    const nav = screen.getByRole('button', { name: 'Go to Logs' })
    nav.focus()
    fireEvent.click(nav)
    const again = await screen.findByRole('combobox', { name: 'Run' })
    expect(again).toHaveValue('run-new')
    expect(screen.getByRole('button', { name: /^sub-001,/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(nav).toHaveFocus()
  })

  it('leaves focus the operator placed while the hand-off waited for the jobs', async () => {
    const api = createMockApi()
    window.supraspina = api
    const cfg = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/projects/logs' },
    }
    const result = await api.project.create({
      at: '/projects/logs',
      cfg,
      epoch: 1,
    })
    const restored = deferred<RuntimeSnapshot>()
    const bootstrap = vi
      .spyOn(api.runtime, 'bootstrap')
      .mockReturnValue(restored.promise)
    function HandOff(): ReactNode {
      const { route, setRoute, setLogsFocusRunId } = useApp()
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setLogsFocusRunId('run-old')
              setRoute('logs')
            }}
          >
            Hand over run-old
          </button>
          <button type="button">Elsewhere</button>
          {route === 'logs' && <LogsScreen />}
        </>
      )
    }
    render(
      <AppProvider>
        <Bootstrap result={result}>
          <RuntimeProvider>
            <HandOff />
          </RuntimeProvider>
        </Bootstrap>
      </AppProvider>,
    )

    // Logs opens while the jobs are being restored, so the hand-off waits.
    await waitFor(() => expect(bootstrap).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Hand over run-old' }))
    expect(
      await screen.findByText('Restoring runtime logs...'),
    ).toBeInTheDocument()
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()
    await act(async () => {
      restored.resolve(
        snapshot(
          result.project,
          [
            job({ id: 'job-old', runId: 'run-old' }),
            job({
              id: 'job-new',
              runId: 'run-new',
              status: 'done',
              startedAt: 300,
              endedAt: 400,
            }),
          ],
          {
            runs: [
              run(result.project, { runId: 'run-old' }),
              run(result.project, {
                runId: 'run-new',
                status: 'done',
                startedAt: 300,
                endedAt: 400,
              }),
            ],
          },
        ),
      )
      await Promise.resolve()
    })

    // The hand-off applied (the default run is run-new) and focus stayed.
    const picker = await screen.findByRole('combobox', { name: 'Run' })
    await waitFor(() => expect(picker).toHaveValue('run-old'))
    expect(elsewhere).toHaveFocus()
  })

  it('keeps a hand-off pending until the run has a job of its stage', async () => {
    // A hand-off that reaches Logs after the restore but before the runtime
    // lists the run's jobs must wait rather than select nothing and clear.
    const api = createMockApi()
    window.supraspina = api
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    const cfg = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/projects/logs' },
    }
    const result = await api.project.create({
      at: '/projects/logs',
      cfg,
      epoch: 1,
    })
    const bootstrap = vi
      .spyOn(api.runtime, 'bootstrap')
      .mockImplementation(async () =>
        snapshot(
          result.project,
          [
            job({
              id: 'job-new',
              runId: 'run-new',
              status: 'done',
              exitCode: 0,
              startedAt: 300,
              endedAt: 400,
            }),
            // The handed-over run has a job, but none of the stage yet.
            job({
              id: 'job-old-final',
              runId: 'run-old',
              stepKey: 'final',
              subjectId: null,
              startedAt: 150,
              endedAt: 160,
            }),
          ],
          {
            runs: [
              run(result.project, { runId: 'run-old', endedAt: 250 }),
              run(result.project, {
                runId: 'run-new',
                status: 'done',
                startedAt: 300,
                endedAt: 400,
              }),
            ],
          },
        ),
      )
    function HandOff(): ReactNode {
      const { route, setRoute, setLogsFocusRunId } = useApp()
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setLogsFocusRunId('run-old', 'recon')
              setRoute('logs')
            }}
          >
            View the Reconstruction log
          </button>
          {route === 'logs' && <LogsScreen />}
        </>
      )
    }
    render(
      <AppProvider>
        <Bootstrap result={result}>
          <RuntimeProvider>
            <HandOff />
          </RuntimeProvider>
        </Bootstrap>
      </AppProvider>,
    )
    await waitFor(() => expect(bootstrap).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'View the Reconstruction log' }),
    )
    const picker = await screen.findByRole('combobox', { name: 'Run' })
    // Nothing of the stage is listed yet, so Logs shows its default run.
    expect(picker).toHaveValue('run-new')

    await act(async () => {
      publish?.({
        projectId: result.project.projectId,
        projectEpoch: result.project.epoch,
        sidecarGeneration: 1,
        runId: 'run-old',
        kind: 'job',
        sequence: 5,
        at: 200,
        job: {
          ...job({
            id: 'job-old-recon',
            runId: 'run-old',
            subjectId: 'sub-007',
            startedAt: 100,
            endedAt: 200,
          }),
          projectId: result.project.projectId,
          projectEpoch: result.project.epoch,
          sidecarGeneration: 1,
        },
      })
    })
    await waitFor(() => expect(picker).toHaveValue('run-old'))
    expect(screen.getByRole('button', { name: /^sub-007,/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it("selects the handed-over stage's newest job of the run", async () => {
    // Runs "View log for Reconstruction" must select a Reconstruction job, not
    // the run's first listed job, here a failed R analysis.
    function HandOff(): ReactNode {
      const { route, setRoute, setLogsFocusRunId } = useApp()
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setLogsFocusRunId('run-8', 'recon')
              setRoute('logs')
            }}
          >
            View the Reconstruction log
          </button>
          {route === 'logs' && <LogsScreen />}
        </>
      )
    }
    const api = createMockApi()
    window.supraspina = api
    const cfg = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/projects/logs' },
    }
    const result = await api.project.create({
      at: '/projects/logs',
      cfg,
      epoch: 1,
    })
    const bootstrap = vi
      .spyOn(api.runtime, 'bootstrap')
      .mockImplementation(async () =>
        snapshot(
          result.project,
          [
            job({
              id: 'job-final',
              runId: 'run-8',
              stepKey: 'final',
              subjectId: null,
              startedAt: 900,
              endedAt: 950,
            }),
            job({
              id: 'job-recon-older',
              runId: 'run-8',
              status: 'done',
              exitCode: 0,
              subjectId: 'sub-001',
              startedAt: 100,
              endedAt: 200,
            }),
            job({
              id: 'job-recon-newer',
              runId: 'run-8',
              status: 'done',
              exitCode: 0,
              subjectId: 'sub-002',
              startedAt: 300,
              endedAt: 400,
            }),
            job({
              id: 'job-enigma',
              runId: 'run-8',
              status: 'done',
              exitCode: 0,
              stepKey: 'enigma',
              subjectId: null,
              startedAt: 500,
              endedAt: 600,
            }),
          ],
          { runs: [run(result.project, { runId: 'run-8', endedAt: 950 })] },
        ),
      )
    render(
      <AppProvider>
        <Bootstrap result={result}>
          <RuntimeProvider>
            <HandOff />
          </RuntimeProvider>
        </Bootstrap>
      </AppProvider>,
    )
    // The hand-off comes from Runs, which the restored jobs reached first.
    await waitFor(() => expect(bootstrap).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'View the Reconstruction log' }),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    const picker = await within(rail).findByRole('combobox', { name: 'Run' })
    await waitFor(() => expect(picker).toHaveValue('run-8'))
    expect(
      within(rail).getByRole('button', { name: /^sub-002,/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(rail).getByRole('button', { name: /^Cohort,.*R analysis/ }),
    ).toHaveAttribute('aria-pressed', 'false')
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    expect(
      within(controls).getByText(fullText('sub-002 / Reconstruction')),
    ).toBeInTheDocument()
  })

  it("brings the handed-over stage's job into view, keeps it there, and streams its log", async () => {
    // The stage's newest job can sit below the rail's fold (row 13 of 140, at
    // 1227 px in a 576 px rail); Logs scrolls it into view and streams its log
    // rather than All jobs.
    const ROW = 32
    const RAIL_HEIGHT = 576
    const SETTLED_RAIL_HEIGHT = 304
    const ENIGMA_TOP = 1227
    let railHeight = RAIL_HEIGHT
    const railRow = (el: Element): boolean =>
      el.matches('button[aria-pressed]') &&
      el.closest('aside[aria-label="Jobs"]') !== null
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement): number {
        if (!railRow(this)) return 0
        return /^Cohort, ENIGMA QC,/.test(this.getAttribute('aria-label') ?? '')
          ? ENIGMA_TOP
          : 40
      },
    )
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement): number {
        return railRow(this) ? ROW : 0
      },
    )
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: Element): number {
        return this.matches('aside[aria-label="Jobs"]') ? railHeight : 0
      },
    )
    // The rail can settle from 360 to 304 px after the reveal, which leaves the
    // row below its fold. jsdom has no ResizeObserver; this one reports a
    // resize when the test asks.
    const observed = new Map<Element, () => void>()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly targets: Element[] = []
        constructor(private readonly callback: (entries: []) => void) {}
        observe(target: Element): void {
          this.targets.push(target)
          observed.set(target, () => this.callback([]))
        }
        disconnect(): void {
          for (const target of this.targets) observed.delete(target)
        }
        unobserve(): void {}
      },
    )
    // The jsdom environment does not scroll on focus, but the browser scrolls
    // the rail to show a focused control. A plain focus on the Run list, at the
    // top of the rail, would undo the reveal (scrollTop 481 -> 0).
    const realFocus = HTMLElement.prototype.focus
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ): void {
      realFocus.call(this, options)
      const rail = this.closest('aside[aria-label="Jobs"]')
      if (rail !== null && options?.preventScroll !== true) {
        rail.scrollTop = Math.min(rail.scrollTop, this.offsetTop)
      }
    })
    function HandOff(): ReactNode {
      const { route, setRoute, setLogsFocusRunId } = useApp()
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setLogsFocusRunId('run-8', 'enigma')
              setRoute('logs')
            }}
          >
            View the ENIGMA QC log
          </button>
          {route === 'logs' && <LogsScreen />}
        </>
      )
    }
    const api = createMockApi()
    window.supraspina = api
    const cfg = {
      ...DEFAULT_PROJECT_CONFIG,
      paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/projects/logs' },
    }
    const result = await api.project.create({
      at: '/projects/logs',
      cfg,
      epoch: 1,
    })
    const line = (id: string, jobId: string, text: string) => ({
      id,
      runId: 'run-8',
      jobId,
      at: 700,
      level: 'ERROR' as const,
      line: text,
    })
    const bootstrap = vi
      .spyOn(api.runtime, 'bootstrap')
      .mockImplementation(async () =>
        snapshot(
          result.project,
          [
            job({
              id: 'job-final',
              runId: 'run-8',
              stepKey: 'final',
              subjectId: null,
              startedAt: 900,
              endedAt: 950,
            }),
            job({
              id: 'job-enigma',
              runId: 'run-8',
              stepKey: 'enigma',
              subjectId: null,
              startedAt: 500,
              endedAt: 600,
            }),
          ],
          {
            runs: [run(result.project, { runId: 'run-8', endedAt: 950 })],
            logTail: [
              line('log-final', 'job-final', 'R analysis failed'),
              line('log-enigma', 'job-enigma', 'ENIGMA QC failed'),
            ],
          },
        ),
      )
    render(
      <AppProvider>
        <Bootstrap result={result}>
          <RuntimeProvider>
            <HandOff />
          </RuntimeProvider>
        </Bootstrap>
      </AppProvider>,
    )
    await waitFor(() => expect(bootstrap).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'View the ENIGMA QC log' }),
    )

    const rail = await screen.findByRole('complementary', { name: 'Jobs' })
    await waitFor(() =>
      expect(
        within(rail).getByRole('button', { name: /^Cohort, ENIGMA QC,/ }),
      ).toHaveAttribute('aria-pressed', 'true'),
    )
    // Only the rail scrolls, just enough to show the whole row, and the
    // hand-off focus on the Run list keeps it there.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(rail).getByRole('combobox', { name: /run/i }),
      ),
    )
    expect(rail.scrollTop).toBe(ENIGMA_TOP + ROW - RAIL_HEIGHT)
    // The rail settles shorter after arriving; the row stays in view.
    railHeight = SETTLED_RAIL_HEIGHT
    act(() => observed.get(rail)?.())
    expect(rail.scrollTop).toBe(ENIGMA_TOP + ROW - SETTLED_RAIL_HEIGHT)
    vi.unstubAllGlobals()
    expect(screen.getByRole('radio', { name: 'Selected job' })).toBeChecked()
    const stream = screen.getByRole('region', { name: 'Log stream' })
    expect(within(stream).getByText('ENIGMA QC failed')).toBeInTheDocument()
    expect(within(stream).queryByText('R analysis failed')).toBeNull()
  })
})

describe('LogsScreen descriptions', () => {
  it('states the level meanings and panel descriptions as facts', async () => {
    await renderScreen((project) => snapshot(project, [job()]))
    await screen.findByText('backend failure')
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    const stream = screen.getByRole('region', { name: 'Log stream' })
    // The level filter sits in the stream toolbar, not in the right rail.
    const level = within(stream).getByRole('radiogroup', {
      name: 'Minimum level',
    })
    expect(within(controls).queryByRole('radiogroup')).toBeNull()
    expect(
      within(level)
        .getAllByRole('radio')
        .map((option) => option.textContent),
    ).toEqual(['Info', 'Warn', 'Error'])
    const hints: string[] = []
    for (const [name, hint] of [
      ['Info', 'The stream shows routine progress, warnings, and errors.'],
      ['Warn', 'The stream shows warnings and errors only.'],
      ['Error', 'The stream shows errors only.'],
    ] as const) {
      // Each option explains itself in its tooltip, not in standing text.
      expect(within(level).getByRole('radio', { name })).toHaveAttribute(
        'title',
        hint,
      )
      expect(screen.queryByText(hint)).toBeNull()
      hints.push(hint)
    }
    const exportButton = within(controls).getByRole('button', {
      name: 'Export debug bundle...',
    })
    const exportNote =
      'Previews the categories first, applies the required redaction, and writes only to a destination you approve.'
    expect(exportButton).toHaveAttribute('title', exportNote)
    expect(exportButton).toHaveStyle({ alignSelf: 'flex-start' })
    expect(screen.queryByText(exportNote)).toBeNull()
    // A description states what the screen shows; only a control or a
    // remedy for an empty view opens with an order.
    for (const text of [...hints, exportNote]) {
      expect(text).not.toMatch(/^(Review|Select|Preview|Retrieve|Wait)\b/)
    }
  })
})

describe('LogsScreen freshness stamp', () => {
  it('stamps the newest job change or line and says what it measures', async () => {
    // The newest job can finish (6:36 PM) after the newest line of the bounded
    // tail (6:17 PM); the stamp follows the job.
    const lineAt = Date.UTC(2026, 8, 23, 22, 17, 0)
    const jobEndedAt = Date.UTC(2026, 8, 23, 22, 36, 29)
    await renderScreen((project) =>
      snapshot(
        project,
        [
          job({
            id: 'job-final-r',
            stepKey: 'final',
            subjectId: null,
            startedAt: lineAt - 60_000,
            endedAt: lineAt,
          }),
          job({
            id: 'job-brain-pad',
            status: 'done',
            exitCode: 0,
            stepKey: 'final',
            subjectId: null,
            startedAt: jobEndedAt - 60_000,
            endedAt: jobEndedAt,
          }),
        ],
        {
          logTail: [
            {
              id: 'log-final-r',
              runId: 'run-1',
              jobId: 'job-final-r',
              at: lineAt,
              level: 'ERROR',
              line: 'R analysis failed.',
            },
          ],
        },
      ),
    )
    const expected = `Last updated ${formatRunTime(new Date(jobEndedAt).toISOString())}`
    const stamp = await screen.findByText(expected)
    expect(stamp).toHaveAttribute(
      'title',
      `The newest job change or log line in Logs is from ${runTimestampLabel(jobEndedAt)}.`,
    )
  })
})

describe('LogsScreen header', () => {
  it('keeps the header to one row with the title and the controls', async () => {
    const { view } = await renderScreen((project) => snapshot(project, [job()]))
    await screen.findByText('backend failure')
    const header = view.container.querySelector('header')
    if (!header) throw new Error('Render the Logs header.')
    const title = within(header).getByRole('heading', {
      level: 1,
      name: 'Logs',
    })
    expect(Array.from(header.children)).toHaveLength(2)
    expect(header.children[0]).toBe(title.parentElement)
    expect(title.parentElement?.children).toHaveLength(1)
    expect(header).toHaveStyle({ alignItems: 'center' })
    expect(
      within(header).getByRole('button', { name: 'Refresh run manifest' }),
    ).toBeInTheDocument()
  })
})

describe('LogsScreen identifier presentation', () => {
  it('presents the job rail and log stream without raw job or run identifiers', async () => {
    await renderScreen((project) => snapshot(project, [job()]))

    const rail = screen.getByRole('complementary', { name: 'Jobs' })
    const railButton = await within(rail).findByRole('button', {
      name: /sub-001/,
    })
    expect(railButton.getAttribute('aria-label')).not.toMatch(/job-1|run-1/)
    expect(railButton.getAttribute('title') ?? '').not.toMatch(/job-1|run-1/)
    expect(within(rail).queryByText(/job-1|run-1/)).toBeNull()

    const stream = screen.getByRole('log', { name: 'Log stream output' })
    expect(await within(stream).findByText('backend failure')).toBeVisible()
    expect(within(stream).queryByText(/job-1|run-1/)).toBeNull()
    expect(
      within(stream).getByText(
        `run ${new Date(100).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}`,
      ),
    ).toBeInTheDocument()
  })

  it('states that the run of a job is outside the loaded run history', async () => {
    await renderScreen((project) => snapshot(project, [job()], { runs: [] }))

    await screen.findByRole('button', { name: /sub-001/ })
    expect(
      screen.getByText(
        'The run of this job is outside the loaded run history.',
      ),
    ).toBeInTheDocument()
  })

  it('names the selected job and its run in human terms', async () => {
    await renderScreen((project) => snapshot(project, [job()]))

    await screen.findByRole('button', { name: /sub-001/ })
    const controls = screen.getByRole('complementary', { name: 'Controls' })
    expect(within(controls).queryByText('job-1')).toBeNull()
    expect(screen.queryByText(/Review run-1\./)).toBeNull()
    expect(
      within(controls).getByText(fullText('sub-001 / Reconstruction')),
    ).toBeInTheDocument()
    expect(within(controls).getByText('This run is a dry run.')).toBeVisible()
    fireEvent.click(screen.getByRole('radio', { name: 'Selected job' }))
    // The footer counts the lines; the selected job is named in its card.
    expect(screen.getByText('1 line, Info and above')).toBeInTheDocument()
    expect(screen.queryAllByText(/job-1|run-1/)).toHaveLength(0)
  })

  it('keeps unattributed log rows identifiable through a tooltip only', async () => {
    await renderScreen((project) =>
      snapshot(project, [], {
        logTail: [
          {
            id: 'orphan-log',
            runId: 'run-orphan',
            jobId: 'job-orphan',
            at: 125,
            level: 'INFO',
            line: 'retained after job pruning',
          },
        ],
      }),
    )

    expect(
      await screen.findByText('retained after job pruning'),
    ).toBeInTheDocument()
    expect(screen.queryByText('job job-orphan')).toBeNull()
    expect(screen.queryByText('run run-orphan')).toBeNull()
    expect(
      screen.getByTitle('Job job-orphan; run run-orphan'),
    ).toBeInTheDocument()
  })

  it('retains manifest identifiers with a copy path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await renderScreen((project) => snapshot(project, [job()]))

    const controls = await screen.findByRole('complementary', {
      name: 'Controls',
    })
    // Run details starts collapsed, so no identifier shows until it opens.
    const details = within(controls).getByRole('button', {
      name: 'Run details',
    })
    expect(details).toHaveAttribute('aria-expanded', 'false')
    expect(within(controls).queryByText('run-1')).toBeNull()
    expect(
      within(controls).queryByRole('button', { name: 'Copy identifiers' }),
    ).toBeNull()
    fireEvent.click(details)
    expect(details).toHaveAttribute('aria-expanded', 'true')
    expect(await within(controls).findByText('run-1')).toBeInTheDocument()
    // The config digest shows its two ends on one line; its title holds it
    // whole.
    const config = within(controls).getByText('Config', { selector: 'dt' })
      .nextElementSibling as HTMLElement
    const digest = config.getAttribute('title') ?? ''
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(config).toHaveTextContent(
      `${digest.slice(0, 10)}...${digest.slice(-8)}`,
    )
    expect(config).toHaveStyle({ whiteSpace: 'nowrap' })
    fireEvent.click(
      within(controls).getByRole('button', { name: 'Copy identifiers' }),
    )
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0]?.[0] as string
    expect(copied).toContain('run-1')
    expect(copied).toMatch(/config [0-9a-f]{64}/)
  })

  it('shows the product version and omits a Git row without a proven commit', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const api = createMockApi()
    const originalForRun = api.manifest.forRun
    vi.spyOn(api.manifest, 'forRun').mockImplementation(async (request) => ({
      ...(await originalForRun(request)),
      product: { name: 'Supraspina', version: '20260920.1200.0' },
      git: { repo: '', sha: '', dirty: false },
    }))
    await renderScreen((project) => snapshot(project, [job()]), api)

    const controls = await screen.findByRole('complementary', {
      name: 'Controls',
    })
    fireEvent.click(
      within(controls).getByRole('button', { name: 'Run details' }),
    )
    expect(
      await within(controls).findByText('Supraspina 2026-09-20 12:00 UTC'),
    ).toBeInTheDocument()
    expect(within(controls).getByText('Version')).toBeInTheDocument()
    expect(within(controls).queryByText('Git')).toBeNull()
    fireEvent.click(
      within(controls).getByRole('button', { name: 'Copy identifiers' }),
    )
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0]?.[0] as string
    expect(copied).toContain('version Supraspina 2026-09-20 12:00 UTC')
    expect(copied).not.toContain('git')
  })

  it('names the development build and full commit that wrote the manifest', async () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const api = createMockApi()
    const originalForRun = api.manifest.forRun
    vi.spyOn(api.manifest, 'forRun').mockImplementation(async (request) => ({
      ...(await originalForRun(request)),
      product: {
        name: 'Supraspina',
        version: '20261121.1830.0',
        build: 'development',
      },
      git: { repo: '', sha: commit, dirty: true },
    }))
    await renderScreen((project) => snapshot(project, [job()]), api)

    const controls = await screen.findByRole('complementary', {
      name: 'Controls',
    })
    fireEvent.click(
      within(controls).getByRole('button', { name: 'Run details' }),
    )
    expect(
      await within(controls).findByText(
        fullText(
          'Supraspina 2026-11-21 18:30 UTC, development build 0123456 (modified)',
        ),
      ),
    ).toBeInTheDocument()
    // The version reads as prose; only its commit hash is code.
    expect(within(controls).getByText('0123456').tagName).toBe('CODE')
    expect(within(controls).getByText('Git')).toBeInTheDocument()
    // The Git row shows the commit's two ends; its title holds it whole.
    const git = within(controls).getByTitle(commit)
    expect(git).toHaveTextContent(/^0123456789\.\.\.01234567 \(dirty\)$/)
    expect(git).toHaveStyle({ whiteSpace: 'nowrap' })
    fireEvent.click(
      within(controls).getByRole('button', { name: 'Copy identifiers' }),
    )
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0]?.[0] as string
    expect(copied).toContain(
      'version Supraspina 2026-11-21 18:30 UTC, development build 0123456 (modified)',
    )
    expect(copied).toContain(`git ${commit} (dirty)`)
  })

  it('names the release build by its version alone', async () => {
    const api = createMockApi()
    const originalForRun = api.manifest.forRun
    vi.spyOn(api.manifest, 'forRun').mockImplementation(async (request) => ({
      ...(await originalForRun(request)),
      product: {
        name: 'Supraspina',
        version: '20261121.1830.0',
        build: 'release',
      },
      git: { repo: '', sha: 'a'.repeat(40), dirty: false },
    }))
    await renderScreen((project) => snapshot(project, [job()]), api)

    const controls = await screen.findByRole('complementary', {
      name: 'Controls',
    })
    fireEvent.click(
      within(controls).getByRole('button', { name: 'Run details' }),
    )
    expect(
      await within(controls).findByText('Supraspina 2026-11-21 18:30 UTC'),
    ).toBeInTheDocument()
  })
})
