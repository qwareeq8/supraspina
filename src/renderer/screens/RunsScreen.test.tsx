import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { version as APP_VERSION } from '../../../package.json'
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from '@testing-library/react'
import {
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import { AppProvider, useApp } from '../state/context'
import { runTimestampLabel } from '../state/run-label'
import { RuntimeProvider } from '../state/runtime-context'
import { getApi } from '../state/api'
import { forgetCropInventory } from '../state/crop-inventory'
import type { InputFovItem } from '../../shared/scientific-contracts'
import { RunsScreen } from './RunsScreen'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectConfig } from '../../shared/project-schema'
import { MATRIX_STEPS, PIPELINE_STEPS } from '../../shared/steps'
import { STEP_HELP } from '../../shared/help'
import {
  REQUIRED_SIDECAR_CAPABILITIES,
  type HostState,
  type ResultArtifact,
  type RunSnapshot,
  type RuntimeEvent,
  type RuntimeSnapshot,
  type WorkflowNode,
  type WorkflowResult,
  type WorkflowSummary,
} from '../../shared/contract'
import { PlanStaleError } from '../../shared/rpc-errors'
import {
  emptyCell,
  type CellState,
  type EnvCheck,
  type EnvReport,
  type Job,
  type ManifestStep,
  type RunManifest,
  type StageBlocker,
  type Subject,
} from '../../shared/types'
import { computeStageBlockers } from '../state/stage-blockers'
import { projectSubjectRuntimeStatus } from '../state/subject-runtime-status'

// Approve every plan review unless a test cancels it; a read-only plan
// closes at once and records its arguments.
const workflowReview = vi.hoisted(() => ({
  approve: true,
  inspected: [] as unknown[][],
}))

vi.mock(import('../state/workflow-review-state'), async (importOriginal) => ({
  ...(await importOriginal()),
  useWorkflowReview: () => ({
    review: async () => workflowReview.approve,
    inspect: async (...args: unknown[]) => {
      workflowReview.inspected.push(args)
    },
  }),
}))

const RESOLVED_CFG: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: '/tmp/sci',
    rawdataDir: '/tmp/sci/rawdata',
    derivativesDir: '/tmp/sci/derivatives',
    outputDir: '/tmp/sci/outputs',
    metadataDir: '/tmp/sci/metadata',
    clinicalMetadataFile: '/tmp/sci/metadata/clinical.csv',
    ageMetadataFile: '/tmp/sci/metadata/age.csv',
    qcOutputDir: '/tmp/sci/qc',
  },
}

const RUNS_PROJECT = {
  projectId: 'runs-project',
  root: '/tmp/sci',
  configPath: '/tmp/sci/supraspina.project.json',
  epoch: 1,
}

const ATTACHED_HOST: HostState = {
  mode: 'browser',
  platform: null,
  captionMode: 'none',
  sidecar: {
    state: 'ready',
    generation: 1,
    productVersion: APP_VERSION,
    protocolVersion: '1',
    persistenceVersions: {
      project: 1,
      runState: 1,
      manifest: 1,
      receipt: 1,
    },
    capabilities: [...REQUIRED_SIDECAR_CAPABILITIES],
    runtimeId: 'runtime-runs',
    projectAttached: true,
    retryable: false,
    detail: null,
  },
}

/** The recovery cards' reason while the runtime restore has not answered. */
const RUN_HISTORY_NOT_RESTORED = 'The run history has not been restored.'

/** The Clean up card's reason while Allow live runs is off. */
const CLEANUP_SAFE_EXECUTION_OFF =
  'Allow live runs is off. Turn it on in Execution controls to clean up.'

const SUMMARY: WorkflowSummary = {
  planned: 0,
  started: 0,
  waiting: 0,
  blocked: 0,
  skipped: 0,
  message: 'Review runtime state.',
}

function fulfilledOutcome(
  disposition: 'blocked' | 'noop',
  message: string,
  action?: string,
): WorkflowResult {
  const summary: WorkflowSummary = {
    planned: 0,
    started: 0,
    waiting: 0,
    blocked: disposition === 'blocked' ? 1 : 0,
    skipped: 0,
    message,
  }
  return {
    runId: null,
    disposition,
    plan: {
      planId: `outcome-${disposition}`,
      analysisCohort: { subjectIds: ['sub-001'], sha256: 'analysis' },
      selectedSubset: { subjectIds: ['sub-001'], sha256: 'selected' },
      nodes: [],
      blockers:
        disposition === 'blocked'
          ? [
              {
                key: 'recon',
                kind: 'cohort',
                reason: message,
                ...(action ? { action } : {}),
              },
            ]
          : [],
      summary,
    },
    summary,
  }
}

function runSnapshot(
  runId: string,
  status: RunSnapshot['status'],
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  const terminal = [
    'done',
    'failed',
    'cancelled',
    'interrupted',
    'persistence-error',
  ].includes(status)
  return {
    runId,
    projectId: RUNS_PROJECT.projectId,
    projectEpoch: RUNS_PROJECT.epoch,
    status,
    startedAt: 1,
    endedAt: terminal ? 2 : null,
    dryRun: false,
    durable: true,
    analysisSubjectIds: ['sub-001'],
    selectedSubjectIds: ['sub-001'],
    acknowledgements: {
      includeDeferredAndUnreviewedQc: false,
      acknowledgeMemoryAdvisory: false,
    },
    summary: SUMMARY,
    ...overrides,
  }
}

/** One node of a started plan, keyed as the sidecar keys it. */
function planNode(
  stepKey: WorkflowNode['stepKey'],
  subjectId: string | null,
  status: WorkflowNode['status'],
  dependencies: string[] = [],
): WorkflowNode {
  return {
    nodeId: `${stepKey}:${subjectId ?? 'cohort'}`,
    stepKey,
    scope: subjectId === null ? 'cohort' : 'subject',
    subjectId,
    status,
    dependencies,
  }
}

function runtimeSnapshot(
  runs: RunSnapshot[] = [],
  jobs: Job[] = [],
): RuntimeSnapshot {
  return {
    project: RUNS_PROJECT,
    sidecarGeneration: 1,
    sequence: 1,
    runs,
    jobs,
    logTail: [],
    provision: null,
  }
}

function RouteProbe(): ReactNode {
  const { route, resultsStage, logsFocusRunId, logsFocusStepKey } = useApp()
  // The run, and the stage, handed over to Logs, which Logs reads once and
  // then clears.
  return (
    <output
      data-testid="route-probe"
      data-logs-focus={logsFocusRunId ?? ''}
      data-logs-focus-stage={logsFocusStepKey ?? ''}
    >
      {`${route}:${resultsStage}`}
    </output>
  )
}

function HostProbe(): ReactNode {
  const { hostState } = useApp()
  return (
    <output data-testid="host-probe">
      {hostState?.sidecar.state ?? 'unavailable'}
    </output>
  )
}

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: '#job',
    stepKey: 'recon',
    subjectId: null,
    startedAt: 0,
    endedAt: null,
    exitCode: null,
    cmd: '',
    stdoutPath: '',
    stderrPath: '',
    envSnapshotPath: '',
    configSnapshotPath: '',
    status: 'running',
    ...overrides,
  }
}

/** One Input QC crop of a subject, with its review decision if any. */
function cropItem(
  subjectId: string,
  decision: 'approved' | 'rejected' | null,
  signature = `sig-${subjectId}`,
): InputFovItem {
  return {
    subjectId,
    sessionId: null,
    acquisitionId: null,
    preflightSignature: signature,
    sourceSha256: 'a'.repeat(64),
    outputSha256: 'b'.repeat(64),
    passThrough: false,
    requiresReview: true,
    qcArtifactId: `qc-${subjectId}-${signature}`,
    qcDisplayPath: `/p/${subjectId}-${signature}.png`,
    review:
      decision === null
        ? null
        : {
            decision,
            revision: 1,
            configRevision: 0,
            reviewedAt: '2026-09-30T00:00:00Z',
            decisionSignature: 'c'.repeat(64),
            current: true,
          },
  }
}

beforeEach(() => {
  forgetCropInventory()
})

afterEach(() => {
  vi.restoreAllMocks()
  forgetCropInventory()
  workflowReview.approve = true
  workflowReview.inspected = []
})

beforeEach(() => {
  vi.spyOn(getApi().host, 'getState').mockResolvedValue(ATTACHED_HOST)
})

function Bootstrap({
  children,
  safeExecution = false,
  cfg = RESOLVED_CFG,
}: {
  children: ReactNode
  safeExecution?: boolean
  /** The saved project configuration the execution service plans with. */
  cfg?: ProjectConfig
}): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (booted.current) return
    booted.current = true
    app.markProjectCreated({
      project: RUNS_PROJECT,
      cfg,
      configSha256: '0'.repeat(64),
    })
    app.setSafeExecution(safeExecution)
    if (safeExecution) void app.saveProject()
  }, [app, safeExecution, cfg])
  if (
    safeExecution &&
    (!app.safeExecution ||
      app.dirty ||
      app.hostState?.sidecar.state !== 'ready')
  ) {
    return null
  }
  return children
}

function withProvider(
  ui: ReactElement,
  options: { safeExecution?: boolean; cfg?: ProjectConfig } = {},
): ReactElement {
  return (
    <AppProvider>
      <Bootstrap
        {...(options.safeExecution === undefined
          ? {}
          : { safeExecution: options.safeExecution })}
        {...(options.cfg === undefined ? {} : { cfg: options.cfg })}
      >
        <RuntimeProvider>{ui}</RuntimeProvider>
      </Bootstrap>
    </AppProvider>
  )
}

const LOW_MEMORY_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 1,
  groups: [],
}

/**
 * Report stale ENIGMA QC assets beside a ready MATLAB backend. The acquisition
 * is an offline rebuild when `offline` is set, and a download otherwise.
 */
function assetRebuildReport(offline: boolean): EnvReport {
  const found = (id: string): EnvCheck => ({ id, label: id, status: 'found' })
  return {
    capturedAt: '2026-09-23T00:00:00.000Z',
    availableMemoryGB: 64,
    groups: [
      {
        name: 'Pipeline assets',
        checks: [
          {
            id: 'scientific_assets',
            label: 'Reviewed scientific assets',
            status: 'missing',
            recommendedCmd: 'supraspina-sidecar acquire-scientific-assets',
            ...(offline ? { offlineInstall: true } : {}),
          },
          { id: 'enigma_assets', label: 'ENIGMA QC assets', status: 'missing' },
        ],
      },
      {
        name: 'Tools',
        checks: [
          'bash',
          'awk',
          'grep',
          'cat',
          'mkdir',
          'display',
          'matlab',
        ].map(found),
      },
    ],
  }
}

/** The ENIGMA QC blocker the shell derives from a report. */
function enigmaBlockers(report: EnvReport): StageBlocker[] {
  return computeStageBlockers(report, RESOLVED_CFG).filter(
    (blocker) => blocker.key === 'enigma',
  )
}

function unknownProvenanceReconArtifact(
  overrides: Partial<ResultArtifact> = {},
): ResultArtifact {
  return {
    artifactId: 'unknown-recon-sub-001',
    label: 'Recon directory',
    stepKey: 'recon',
    subjectId: 'sub-001',
    kind: 'dir',
    presence: 'produced',
    displayPath: 'recon/sub-001',
    exists: true,
    openable: true,
    revealable: true,
    runId: null,
    producerNodeId: null,
    receiptSha256: null,
    provenance: 'unknown',
    ...overrides,
  }
}

function cohortWithReconCell(
  st: CellState,
  err: string | null = null,
): Subject[] {
  const cells = MATRIX_STEPS.map(() => emptyCell())
  const recon = cells[0]
  if (recon) {
    recon.st = st
    recon.err = err
  }
  return [
    {
      id: 'sub-001',
      age: 40,
      sex: 'M',
      cohort: 'CTRL',
      ais: null,
      tSinceSci: null,
      cells,
      stepStates: { brainfov: 'done', recon: st },
      qc: 'pass',
      notes: '',
      registered: true,
      analysisEligible: true,
      unavailableReason: null,
    },
  ]
}

/** One subject per reason, each with a failed Reconstruction cell. */
function cohortWithFailedRecon(reasons: readonly (string | null)[]): Subject[] {
  return reasons.map((err, index) => {
    const [subject] = cohortWithReconCell('failed', err)
    if (!subject) throw new Error('Build the failed Reconstruction fixture.')
    return { ...subject, id: `sub-${String(index + 1).padStart(3, '0')}` }
  })
}

function cohort(n: number): Subject[] {
  return Array.from(
    { length: n },
    (_, i): Subject => ({
      id: `sub-${String(i + 1).padStart(3, '0')}`,
      age: 40,
      sex: 'M',
      cohort: 'CTRL',
      ais: null,
      tSinceSci: null,
      cells: MATRIX_STEPS.map(() => emptyCell()),
      qc: 'pass',
      notes: '',
      registered: true,
      analysisEligible: true,
      unavailableReason: null,
    }),
  )
}

const FAILED_RUN_STARTED = Date.parse('2026-09-22T14:17:28')

function shortRunTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

/**
 * The stage card whose Run button and heading name `stage`. The button is
 * found by its aria-label, its accessible name: a role query computes the
 * name of every button on this page, which on a cold or loaded worker took
 * about a second per call, and the tests poll this inside waitFor.
 */
function stageCard(stage: string): HTMLElement {
  const runs = document.querySelectorAll<HTMLElement>(
    `button[aria-label="Run ${stage}"]`,
  )
  if (runs.length !== 1) {
    throw new Error(`Find exactly one Run ${stage} button, not ${runs.length}.`)
  }
  let card: HTMLElement | null = runs[0] ?? null
  const titled = (node: HTMLElement): boolean =>
    [...node.querySelectorAll('span')].some(
      (span) => span.textContent === stage,
    )
  while (card && !titled(card)) card = card.parentElement
  if (!card) throw new Error(`Find the ${stage} stage card.`)
  return card
}

/** The outermost live regions whose text includes `text`. */
function liveRegionsWith(text: string): HTMLElement[] {
  const selector = '[role="status"], [role="alert"], [aria-live]'
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (region) =>
      region.textContent?.includes(text) &&
      // Count the outermost region once; a nested one repeats it.
      !region.parentElement?.closest(selector),
  )
}

describe('RunsScreen', () => {
  it('should render the action cards when first mounted', async () => {
    render(withProvider(<RunsScreen />))
    // Without an explicit selection Run all already runs the whole cohort,
    // and its title says so. The button beside it may read Run all too.
    const titles = (await screen.findAllByText('Run all')).filter(
      (element) => !element.closest('button'),
    )
    expect(titles).toHaveLength(1)
    expect(screen.queryByText('Run all selected')).toBeNull()
    expect(screen.getByText('Resume failed work')).toBeTruthy()
    expect(screen.queryByText('Run whole cohort')).toBeNull()
  })

  it('titles the first card for the selection while one is explicit', async () => {
    render(withProvider(<RunsScreen selection={['sub-001']} />))
    expect(await screen.findByText('Run all selected')).toBeTruthy()
    expect(screen.queryByText('Run all')).toBeNull()
    expect(screen.getByText('Run whole cohort')).toBeTruthy()
  })

  it('should default the dry-run switch to on when first rendered', async () => {
    render(withProvider(<RunsScreen />))
    const toggle = await screen.findByRole('switch', { name: 'Dry run first' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    // The tooltip states what a dry run does rather than ordering the reader,
    // and the switch needs no state line while it is on.
    expect(toggle.closest('[title]')).toHaveAttribute(
      'title',
      'Prints each command to Logs without executing it.',
    )
    expect(screen.queryByText('Commands execute on this host.')).toBeNull()
  })

  it('should pass dryRun true through the scoped workflow request', async () => {
    const api = getApi()
    const planSpy = vi.spyOn(api.pipeline, 'planWorkflow')
    const runSpy = vi.spyOn(api.pipeline, 'runWorkflow')
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
        />,
      ),
    )
    const reconRun = await screen.findByRole('button', {
      name: 'Run Reconstruction',
    })
    // A stage Run stays outlined; the Run all card holds the one accent.
    expect(reconRun.style.borderStyle).toBe('solid')
    fireEvent.click(reconRun)
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    await waitFor(() => expect(planSpy).toHaveBeenCalled())
    const call = planSpy.mock.calls[0]
    if (!call) throw new Error('Request a plan in this fixture.')
    expect(call[0].cfg.runtime.dryRun).toBe(true)
    expect(runSpy).toHaveBeenCalledOnce()
    expect(runSpy.mock.calls[0]?.[0]).not.toHaveProperty(
      'liveExecutionAuthorization',
    )
  })

  it('offers View results on a finished stage and deep-links to Results', async () => {
    render(
      withProvider(
        <>
          <RunsScreen
            cfg={RESOLVED_CFG}
            subjects={cohortWithReconCell('done')}
          />
          <RouteProbe />
        </>,
      ),
    )
    const view = await screen.findByRole('button', {
      name: 'View results for Reconstruction',
    })
    fireEvent.click(view)
    expect(screen.getByTestId('route-probe')).toHaveTextContent('results:recon')
  })

  it('Offers Results for produced stages without subject-matrix columns.', async () => {
    const api = getApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      producedStepKeys: ['brainfov', 'outliers'],
    })
    render(
      withProvider(
        <>
          <RunsScreen cfg={RESOLVED_CFG} subjects={cohort(1)} />
          <RouteProbe />
        </>,
      ),
    )

    const brainFov = await screen.findByRole('button', {
      name: 'View results for Brain FOV preparation',
    })
    expect(
      screen.getByRole('button', {
        name: 'View results for Histogram and outlier review',
      }),
    ).toBeVisible()
    fireEvent.click(brainFov)
    expect(screen.getByTestId('route-probe')).toHaveTextContent(
      'results:brainfov',
    )
  })

  it('names the uncovered subjects instead of only "Not run yet"', async () => {
    // With four subjects added to a 48-subject project, "Not run yet" beside
    // "48 done of 52" would read as a contradiction.
    const subjects = cohort(5)
    for (const subject of subjects.slice(0, 3)) {
      subject.stepStates = { ...subject.stepStates, enigma: 'done' }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))

    expect(
      await screen.findByTitle('ENIGMA QC has not run for 2 of 5 subjects.'),
    ).toHaveTextContent(/^2 not run$/)
    const card = stageCard('ENIGMA QC')
    expect(card.querySelector('[data-stage-counts]')?.textContent).toBe(
      '3 done, 2 not run of 5 subjects',
    )
    // The count line names the uncovered subjects, so no status line repeats
    // them.
    expect(within(card).queryByText('Not run for 2 of 5 subjects')).toBeNull()
    expect(card).not.toHaveTextContent('Not run yet')
  })

  it('states a stage that is off as off, not as not run', async () => {
    // "Not run yet" above "Turn on <stage> in the project configuration." would
    // suggest work waiting to run.
    const cfg: ProjectConfig = structuredClone(RESOLVED_CFG)
    cfg.steps.pybrainage = { ...cfg.steps.pybrainage, enabled: false }
    // Optional defacing is off by default; Brain FOV preparation stays on.
    expect(cfg.steps.deface.enabled).toBe(false)
    const subjects = cohort(4)
    for (const subject of subjects) {
      subject.stepStates = {
        ...subject.stepStates,
        brainfov: 'pending',
        deface: subject.id === 'sub-001' ? 'done' : 'pending',
      }
    }
    render(withProvider(<RunsScreen cfg={cfg} subjects={subjects} />))

    await screen.findByRole('button', { name: 'Run PyBrainAge prediction' })
    const pyBrainAge = stageCard('PyBrainAge prediction')
    expect(
      within(pyBrainAge).getByText('Off in project configuration'),
    ).toHaveAttribute(
      'title',
      'PyBrainAge prediction is off in the project configuration, so no run includes it.',
    )
    expect(pyBrainAge).not.toHaveTextContent('Not run')
    // The remedy line stays under the disabled Run.
    expect(pyBrainAge).toHaveTextContent(
      'Turn on PyBrainAge prediction in the project configuration.',
    )
    // A subject stage that is off says so even where it ran for some
    // subjects before, and keeps counting the output it has.
    const defacing = stageCard('Optional defacing')
    expect(
      within(defacing).getByText('Off in project configuration'),
    ).toHaveAttribute(
      'title',
      'Optional defacing is off in the project configuration, so no run includes it.',
    )
    expect(defacing).not.toHaveTextContent('Not run')
    // An off stage states only the output it has, not zero counts.
    expect(defacing.querySelector('[data-stage-counts]')).toHaveTextContent(
      /^1 done of 4 subjects$/,
    )
    expect(defacing).toHaveTextContent(
      'Turn on Optional defacing in the project configuration.',
    )
    // A stage that is on and has not run still says so.
    expect(stageCard('Brain FOV preparation')).toHaveTextContent('Not run yet')
    expect(stageCard('Brain FOV preparation')).not.toHaveTextContent(
      'Off in project configuration',
    )
  })

  it('counts a per-subject stage against every subject it covers', async () => {
    // After the cohort grows from 52 to 82, per-subject cards state the same
    // denominator as cohort cards ("52 done of 82").
    const subjects = cohort(5)
    for (const subject of subjects.slice(0, 3)) {
      subject.stepStates = { ...subject.stepStates, brainfov: 'done' }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))

    expect(
      await screen.findByTitle(
        'Brain FOV preparation has not run for 2 of 5 subjects.',
      ),
    ).toHaveTextContent(/^2 not run$/)
    expect(
      screen.getByTitle('3 subjects are done in Brain FOV preparation.'),
    ).toHaveTextContent(/^3 done$/)
    expect(
      stageCard('Brain FOV preparation').querySelector('[data-stage-counts]')
        ?.textContent,
    ).toBe('3 done, 2 not run of 5 subjects')
    // The count line states only counts above zero.
    expect(screen.queryByText('0 failed')).toBeNull()
    expect(screen.queryByText('0 running')).toBeNull()
  })

  it('reads a finished cohort stage with a stale receipt as out of date', async () => {
    // An R analysis run is refused while aggregate has no current provenance
    // receipt, so the aggregation card must not read "Done for all 82
    // subjects".
    const api = getApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        aggregate: { state: 'outdated', outdatedSubjectIds: [] },
        enigma: { state: 'current', outdatedSubjectIds: [] },
      },
    })
    const subjects = cohort(3)
    for (const subject of subjects) {
      subject.stepStates = {
        ...subject.stepStates,
        aggregate: 'done',
        enigma: 'done',
      }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))

    // The state line states the fact; the next-run sentence is the title's, not
    // an order on the line.
    expect(await screen.findByText('Out of date')).toHaveAttribute(
      'title',
      'One cohort job: Structural data aggregation no longer matches its current inputs, so the next run repeats it.',
    )
    expect(screen.queryByText(/rerun this stage/)).toBeNull()
    // Only ENIGMA QC reads as done for its 3 subjects, and its status line
    // already says so, so it shows no count line; the out-of-date
    // aggregation counts none done.
    expect(screen.getByText('Done for all 3 subjects')).toBeInTheDocument()
    expect(
      stageCard('ENIGMA QC').querySelector('[data-stage-counts]'),
    ).toBeNull()
    expect(
      stageCard('Structural data aggregation').querySelector(
        '[data-stage-counts]',
      )?.textContent,
    ).toBe('3 out of date of 3 subjects')
    expect(screen.queryByText('3 done')).toBeNull()
    expect(
      screen.getByRole('button', {
        name: 'View results for Structural data aggregation',
      }),
    ).toBeVisible()
  })

  it("keeps a queued cohort stage's output on its card, and says a queued job has not started", async () => {
    // While ENIGMA QC runs, the queued Structural data aggregation card keeps
    // the output the stage has (out of date, not "Not run yet"), and In flight
    // says the job has not started.
    const api = getApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        aggregate: { state: 'outdated', outdatedSubjectIds: [] },
      },
    })
    const ids = ['sub-001', 'sub-002', 'sub-003']
    const runs = [
      runSnapshot('run-73c7e1979332', 'running', {
        analysisSubjectIds: ids,
        selectedSubjectIds: ids,
      }),
    ]
    const jobs = [
      makeJob({
        id: '#enigma',
        runId: 'run-73c7e1979332',
        stepKey: 'enigma',
        status: 'running',
        startedAt: Date.now(),
      }),
      makeJob({
        id: '#aggregate',
        runId: 'run-73c7e1979332',
        stepKey: 'aggregate',
        status: 'queued',
        startedAt: null,
      }),
    ]
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(runs, jobs),
    )
    const discovered = cohort(3)
    for (const subject of discovered) {
      subject.stepStates = {
        ...subject.stepStates,
        enigma: 'done',
        aggregate: 'done',
      }
    }
    vi.spyOn(api.subjects, 'discover').mockResolvedValue(discovered)
    // The shell passes Runs the subjects with the live run's jobs overlaid.
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={projectSubjectRuntimeStatus(discovered, runs, jobs)}
        />,
      ),
    )

    expect(
      await screen.findByText('Queued; out of date for 3 of 3 subjects'),
    ).toHaveAttribute(
      'title',
      'One cohort job: Structural data aggregation is queued.',
    )
    const card = stageCard('Structural data aggregation')
    expect(card).toHaveTextContent('3 queued')
    expect(card).not.toHaveTextContent('Not run yet')
    // The queued job's chip names its state; the elapsed column says only
    // that it has not started.
    expect(await screen.findByText('Not started')).toBeInTheDocument()
    expect(screen.queryByText('waiting')).toBeNull()
  })

  it('counts the stages the active run reaches later as planned, and lists them in flight', async () => {
    // A Run all starts with 5 nodes. While ENIGMA QC runs, outlier review and
    // age integration have no job yet; they still count as planned and show in
    // flight, as the queued stages do.
    const api = getApi()
    const later = ['outliers', 'features', 'age', 'aggregate'] as const
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: Object.fromEntries(
        later.map((key) => [
          key,
          { state: 'outdated' as const, outdatedSubjectIds: [] },
        ]),
      ),
    })
    const ids = ['sub-001', 'sub-002', 'sub-003']
    const runs = [
      runSnapshot('run-1', 'running', {
        analysisSubjectIds: ids,
        selectedSubjectIds: ids,
      }),
    ]
    const jobs = [
      makeJob({
        id: '#enigma',
        runId: 'run-1',
        stepKey: 'enigma',
        status: 'running',
        startedAt: Date.now(),
      }),
      makeJob({
        id: '#features',
        runId: 'run-1',
        stepKey: 'features',
        status: 'queued',
        startedAt: null,
      }),
      makeJob({
        id: '#aggregate',
        runId: 'run-1',
        stepKey: 'aggregate',
        status: 'queued',
        startedAt: null,
      }),
    ]
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(runs, jobs),
    )
    const startedMessage = 'Run run-1 started with 5 jobs.'
    const base = fulfilledOutcome('noop', startedMessage)
    vi.spyOn(api.pipeline, 'runWorkflow').mockResolvedValue({
      ...base,
      runId: 'run-1',
      disposition: 'started',
      plan: {
        ...base.plan,
        nodes: [
          planNode('enigma', null, 'planned'),
          planNode('outliers', null, 'waiting', ['enigma:cohort']),
          planNode('features', null, 'waiting', ['enigma:cohort']),
          planNode('age', null, 'waiting', ['features:cohort']),
          planNode('aggregate', null, 'waiting', ['enigma:cohort']),
        ],
      },
      summary: { ...SUMMARY, started: 5, message: startedMessage },
    })
    const discovered = cohort(3)
    for (const subject of discovered) {
      subject.stepStates = {
        ...subject.stepStates,
        enigma: 'done',
        outliers: 'done',
        features: 'done',
        age: 'done',
        aggregate: 'done',
      }
    }
    vi.spyOn(api.subjects, 'discover').mockResolvedValue(discovered)
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={projectSubjectRuntimeStatus(discovered, runs, jobs)}
        />,
      ),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 3' }))
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Review the run plan?' }),
      ).getByRole('button', { name: 'Review plan' }),
    )
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole('status')
          .some((node) => node.textContent?.includes(startedMessage)),
      ).toBe(true),
    )

    for (const stage of [
      'Histogram and outlier review',
      'Age metadata integration',
    ]) {
      const card = stageCard(stage)
      const state = await within(card).findByText(
        'Planned; out of date for 3 of 3 subjects',
      )
      expect(state).toHaveAttribute(
        'title',
        `One cohort job: ${stage} is planned in run run-1 and has no job yet.`,
      )
      expect(card).toHaveTextContent('3 planned')
    }
    expect(stageCard('FreeSurfer feature extraction')).toHaveTextContent(
      'Queued; out of date for 3 of 3 subjects',
    )
    // In flight lists all 5 of the run's nodes: the running job, the two
    // queued jobs, and the two planned nodes, which have not started.
    expect(screen.getAllByText('Not started')).toHaveLength(4)
    for (const stage of [
      'ENIGMA QC',
      'Histogram and outlier review',
      'FreeSurfer feature extraction',
      'Age metadata integration',
      'Structural data aggregation',
    ]) {
      expect(
        screen.getAllByText(stage, { selector: 'span' }).length,
      ).toBeGreaterThan(1)
    }
  })

  it('names the crops Reconstruction waits for and links to Input QC', async () => {
    // With Brain FOV done for the selected subjects, the Reconstruction card
    // names the plan's blocker, the crop approval in Input QC.
    const runtimeApi = getApi().runtime
    vi.spyOn(runtimeApi, 'bootstrap').mockResolvedValue(runtimeSnapshot([]))
    vi.spyOn(runtimeApi, 'onEvent').mockImplementation(() => () => {})
    const item = (subjectId: string, approved: boolean) => ({
      subjectId,
      sessionId: null,
      acquisitionId: null,
      preflightSignature: `sig-${subjectId}`,
      sourceSha256: 'a'.repeat(64),
      outputSha256: 'b'.repeat(64),
      passThrough: false,
      requiresReview: true,
      qcArtifactId: `qc-${subjectId}`,
      qcDisplayPath: `/p/${subjectId}.png`,
      review: approved
        ? {
            decision: 'approved' as const,
            revision: 1,
            configRevision: 0,
            reviewedAt: '2026-09-30T00:00:00Z',
            decisionSignature: 'c'.repeat(64),
            current: true,
          }
        : null,
    })
    const list = vi
      .spyOn(getApi().inputFov, 'list')
      .mockImplementation(async ({ configRevision }) => ({
        configRevision,
        items: [item('sub-001', false), item('sub-002', false)],
      }))
    const subjects = cohort(2)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, brainfov: 'done' }
    }
    render(
      withProvider(
        <>
          <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={subjects} />
          <RouteProbe />
        </>,
      ),
    )

    await waitFor(() => expect(list).toHaveBeenCalled())
    const card = await waitFor(() => {
      const found = stageCard('Reconstruction')
      expect(found).toHaveTextContent(
        'The Brain FOV crops of 2 subjects wait for approval in Input QC.',
      )
      return found
    })
    expect(
      within(card).getByRole('button', { name: 'Run Reconstruction' }),
    ).toBeDisabled()
    fireEvent.click(within(card).getByRole('button', { name: 'Open Input QC' }))
    expect(screen.getByTestId('route-probe')).toHaveTextContent(/^inputQc:/)
  })

  it('ignores a superseded crop once the current crop is approved', async () => {
    // Input QC keeps the publication of an earlier preflight signature, such as
    // one rejected before a margin change, but the planner reads only the
    // current, approved crop, so the subject does not wait.
    const runtimeApi = getApi().runtime
    vi.spyOn(runtimeApi, 'bootstrap').mockResolvedValue(runtimeSnapshot([]))
    vi.spyOn(runtimeApi, 'onEvent').mockImplementation(() => () => {})
    const list = vi
      .spyOn(getApi().inputFov, 'list')
      .mockImplementation(async ({ configRevision }) => ({
        configRevision,
        items: [
          cropItem('sub-001', 'rejected', 'sig-old'),
          cropItem('sub-001', 'approved'),
          cropItem('sub-002', 'rejected', 'sig-old'),
          cropItem('sub-002', 'approved'),
        ],
      }))
    const subjects = cohort(2)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, brainfov: 'done' }
    }
    render(
      withProvider(
        <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={subjects} />,
      ),
    )

    await waitFor(() => expect(list).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })
    const card = stageCard('Reconstruction')
    expect(card).not.toHaveTextContent(/wait for approval|waits for approval/)
    expect(
      within(card).getByRole('button', { name: 'Run Reconstruction' }),
    ).toBeEnabled()
  })

  it('reads the crop inventory once across Runs visits', async () => {
    // `inputFov.list` hashes every publication on the sidecar's RPC thread, so
    // Runs must not read it again on every visit. No run ends meanwhile, which
    // would read again.
    const api = getApi()
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(runtimeSnapshot([]))
    vi.spyOn(api.runtime, 'onEvent').mockImplementation(() => () => {})
    const list = vi
      .spyOn(getApi().inputFov, 'list')
      .mockImplementation(async ({ configRevision }) => ({
        configRevision,
        items: [cropItem('sub-001', null), cropItem('sub-002', null)],
      }))
    const subjects = cohort(2)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, brainfov: 'done' }
    }
    const reason =
      'The Brain FOV crops of 2 subjects wait for approval in Input QC.'
    const runs = <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={subjects} />
    const { rerender } = render(withProvider(runs))
    await waitFor(() =>
      expect(stageCard('Reconstruction')).toHaveTextContent(reason),
    )
    // Leave Runs and come back within the same project.
    rerender(withProvider(<></>))
    expect(screen.queryByText(reason)).toBeNull()
    rerender(withProvider(runs))
    await waitFor(() =>
      expect(stageCard('Reconstruction')).toHaveTextContent(reason),
    )
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('reads no crop inventory once Reconstruction is done in scope', async () => {
    const list = vi.spyOn(getApi().inputFov, 'list')
    const subjects = cohortWithReconCell('done')
    render(
      withProvider(
        <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={subjects} />,
      ),
    )

    await screen.findByRole('button', { name: 'Run Reconstruction' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(list).not.toHaveBeenCalled()
  })

  it('counts queued subjects of a subject stage apart from subjects it has not run', async () => {
    const api = getApi()
    const ids = ['sub-001', 'sub-002', 'sub-003']
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [
          runSnapshot('run-1', 'running', {
            analysisSubjectIds: ids,
            selectedSubjectIds: ids,
          }),
        ],
        ids.map((subjectId, index) =>
          makeJob({
            id: `#recon-${subjectId}`,
            runId: 'run-1',
            subjectId,
            status: index === 0 ? 'running' : 'queued',
            startedAt: index === 0 ? Date.now() : null,
          }),
        ),
      ),
    )
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={cohort(3)} />))

    expect(await screen.findByText('2 queued')).toHaveAttribute(
      'title',
      '2 subjects are queued in Reconstruction.',
    )
    const card = stageCard('Reconstruction')
    expect(card).toHaveTextContent('1 running')
    expect(card).not.toHaveTextContent('Not run')
  })

  it('names one denominator per card: the selection or the cohort', async () => {
    // With 7 of 100 selected, Brain FOV counts of 7 and ENIGMA QC of 100, so
    // each card names what its denominator counts.
    const subjects = cohort(3)
    subjects[0]!.stepStates = { recon: 'done', enigma: 'done' }
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={subjects}
          selection={['sub-001', 'sub-002']}
        />,
      ),
    )

    const counts = async (stage: string): Promise<string> => {
      const card = await waitFor(() => stageCard(stage))
      const line = card.querySelector('[data-stage-counts]')
      return line?.textContent ?? ''
    }
    expect(await counts('Reconstruction')).toBe(
      '1 done, 1 not run of the 2 selected',
    )
    expect(await counts('ENIGMA QC')).toBe('1 done, 2 not run of 3 subjects')
  })

  it("counts a per-subject stage against its active run's subjects", async () => {
    // After a run starts, the Brain FOV card's denominator follows the run, not
    // a selection made meanwhile.
    const api = getApi()
    const ids = ['sub-001', 'sub-002']
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [
          runSnapshot('run-1', 'running', {
            analysisSubjectIds: ['sub-001', 'sub-002', 'sub-003'],
            selectedSubjectIds: ids,
          }),
        ],
        ids.map((subjectId, index) =>
          makeJob({
            id: `#recon-${subjectId}`,
            runId: 'run-1',
            subjectId,
            status: index === 0 ? 'running' : 'queued',
            startedAt: index === 0 ? Date.now() : null,
          }),
        ),
      ),
    )
    const subjects = cohort(3)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, brainfov: 'pending' }
    }
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={subjects}
          selection={['sub-003']}
        />,
      ),
    )

    await screen.findByText('1 queued')
    expect(
      stageCard('Reconstruction').querySelector('[data-stage-counts]')
        ?.textContent,
    ).toBe('1 running, 1 queued of the 2 in the active run')
    // A stage the run does not reach counts the selection. With no count
    // above zero it has no count line, and its status line names the
    // denominator.
    const brainFov = stageCard('Brain FOV preparation')
    expect(brainFov.querySelector('[data-stage-counts]')).toBeNull()
    expect(within(brainFov).getByText('Not run yet')).toHaveAttribute(
      'title',
      'Brain FOV preparation has not run for 1 of the 1 selected.',
    )
  })

  it('counts a subject the live run just finished as done, not out of date', async () => {
    // With sub-903 finished and sub-906 still running, the currency still lists
    // sub-903 as out of date, since it is read again only when a run ends; this
    // answer comes back before and after.
    const api = getApi()
    let runEnded = false
    let answerReread: (() => void) | null = null
    const list = vi.spyOn(api.results, 'list').mockImplementation(async () => {
      if (runEnded) {
        await new Promise<void>((resolve) => {
          answerReread = resolve
        })
      }
      return {
        items: [],
        nextCursor: null,
        truncated: false,
        stageCurrency: {
          recon: runEnded
            ? { state: 'current', outdatedSubjectIds: [] }
            : { state: 'outdated', outdatedSubjectIds: ['sub-001', 'sub-002'] },
        },
      }
    })
    const ids = ['sub-001', 'sub-002']
    const bootstrap = vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [
          runSnapshot('run-1', 'running', {
            analysisSubjectIds: ids,
            selectedSubjectIds: ids,
          }),
        ],
        [
          makeJob({
            id: '#recon-1',
            runId: 'run-1',
            subjectId: 'sub-001',
            status: 'done',
            startedAt: 1,
            endedAt: 2,
          }),
          makeJob({
            id: '#recon-2',
            runId: 'run-1',
            subjectId: 'sub-002',
            status: 'running',
            startedAt: Date.now(),
          }),
        ],
      ),
    )
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    // Both subjects had finished Reconstruction before this rerun.
    const subjects = cohort(2)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, recon: 'done' }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))

    // Wait on the runtime restore and the currency reads themselves, not on
    // the card's text with the 1 s waitFor budget: on a cold or loaded worker
    // the restore alone can take longer than that.
    const card = (): HTMLElement => stageCard('Reconstruction')
    await waitFor(() => expect(bootstrap).toHaveBeenCalled(), {
      timeout: 5000,
    })
    await act(async () => {
      await bootstrap.mock.results[0]?.value
      await Promise.all(list.mock.results.map((result) => result.value))
    })
    expect(list).toHaveBeenCalled()
    const running = card()
    expect(running).toHaveTextContent('1 running')
    expect(running).toHaveTextContent('1 done')
    expect(running).not.toHaveTextContent('Out of date')

    // The run ends; until the read its end triggers lands, the currency
    // still lists both subjects.
    runEnded = true
    await act(async () => {
      publish?.(
        jobEvent({ id: '#recon-2', subjectId: 'sub-002', status: 'done' }, 2),
      )
      publish?.(
        runEvent(
          runSnapshot('run-1', 'done', {
            analysisSubjectIds: ids,
            selectedSubjectIds: ids,
          }),
          3,
        ),
      )
    })
    await waitFor(() => expect(answerReread).not.toBeNull(), {
      timeout: 5000,
    })
    const ended = card()
    expect(ended).toHaveTextContent('2 done')
    expect(ended).not.toHaveTextContent('Out of date')

    await act(async () => {
      ;(answerReread as (() => void) | null)?.()
    })
    expect(card()).toHaveTextContent('2 done')
  })

  it('counts out-of-date output as existing beside the subjects not run', async () => {
    // After 7 subjects join, "Out of date for 82 of 89 subjects" beside "0
    // done of 89" would read as if no output existed, and the 7 not run would
    // go uncounted.
    vi.spyOn(getApi().results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        aggregate: { state: 'outdated', outdatedSubjectIds: [] },
      },
    })
    const subjects = cohort(4)
    for (const subject of subjects.slice(0, 3)) {
      subject.stepStates = { ...subject.stepStates, aggregate: 'done' }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))

    await screen.findByText('Out of date')
    const card = stageCard('Structural data aggregation')
    const counts = card.querySelector<HTMLElement>('[data-stage-counts]')
    expect(counts).toHaveTextContent(/^3 out of date, 1 not run of 4 subjects$/)
    // Zero counts are left out of the line.
    expect(counts).not.toHaveTextContent(/\b0 (done|running|failed)\b/)
    // A count line is a state sentence, so it reads in sans, not mono.
    expect(counts?.style.fontFamily).toContain('WebCM Sans 10')
    expect(within(card).getByText('1 not run')).toHaveAttribute(
      'title',
      'Structural data aggregation has not run for 1 of 4 subjects.',
    )
    expect(within(card).getByText('1 not run').style.fontFamily).toContain(
      'WebCM Sans 10',
    )
  })

  it('reads the stage as done again once the rerun ends', async () => {
    const api = getApi()
    // Hold the host state back until the first currency read has landed. Under
    // load it arrives that late, and a run event published before the runtime
    // hydrates is dropped, so the test must wait for the hydrated run rather
    // than count reads.
    let attachHost: () => void = () => {}
    const hostAttached = new Promise<HostState>((resolve) => {
      attachHost = () => resolve(ATTACHED_HOST)
    })
    vi.spyOn(api.host, 'getState').mockReturnValue(hostAttached)
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-1', 'running')]),
    )
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    // Every read reports the stage out of date until the rerun has ended, so
    // only a read made after the run event can report it current.
    let rerunEnded = false
    vi.spyOn(api.results, 'list').mockImplementation(async () => ({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        aggregate: {
          state: rerunEnded ? 'current' : 'outdated',
          outdatedSubjectIds: [],
        },
      },
    }))
    const subjects = cohort(2)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, aggregate: 'done' }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))
    expect(await screen.findByText('Out of date')).toBeInTheDocument()
    attachHost()
    // The runtime holds the running rerun, so its end event applies.
    await screen.findByText('A run is active; its jobs have not appeared yet.')
    expect(publish).not.toBeNull()
    rerunEnded = true

    await act(async () => {
      publish?.({
        kind: 'run',
        run: runSnapshot('run-1', 'done'),
        projectId: RUNS_PROJECT.projectId,
        projectEpoch: RUNS_PROJECT.epoch,
        sidecarGeneration: 1,
        sequence: 2,
        runId: 'run-1',
        at: 2,
      })
    })

    expect(
      await screen.findByText('Done for all 2 subjects'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Out of date')).toBeNull()
    // The idle In flight card states facts rather than orders.
    expect(screen.getByText('No job is in flight.')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Launched stages appear here while they run. A dry run writes its commands to the Logs tab without creating a long-lived job.',
      ),
    ).toBeInTheDocument()
  })

  it('states the QC cause on a cohort card and reads done after Refresh', async () => {
    // After new QC verdicts Run all plans every cohort stage again, so no
    // cohort card may read "Done for all 82 subjects".
    const api = getApi()
    const list = vi
      .spyOn(api.results, 'list')
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null,
        truncated: false,
        stageCurrency: {
          enigma: {
            state: 'outdated',
            outdatedSubjectIds: [],
            cause: 'analysis-cohort',
          },
          recon: { state: 'current', outdatedSubjectIds: [] },
        },
        analysisCohortChange: { cause: 'membership' },
      })
      .mockResolvedValue({
        items: [],
        nextCursor: null,
        truncated: false,
        stageCurrency: {
          enigma: { state: 'current', outdatedSubjectIds: [] },
          recon: { state: 'current', outdatedSubjectIds: [] },
        },
        analysisCohortChange: null,
      })
    const subjects = cohort(3)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, enigma: 'done' }
    }
    const refresh = vi.fn()
    render(
      withProvider(
        <RunsScreen cfg={RESOLVED_CFG} subjects={subjects} refresh={refresh} />,
      ),
    )

    expect(await screen.findByText('Out of date')).toBeVisible()
    expect(
      screen.getByText('The analysis cohort changed after this stage ran.'),
    ).toBeVisible()
    const calls = list.mock.calls.length

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh cohort and run state' }),
    )

    expect(refresh).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls))
    expect(
      await screen.findByText('Done for all 3 subjects'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('The analysis cohort changed after this stage ran.'),
    ).toBeNull()
  })

  it('names a membership change on the cohort card', async () => {
    vi.spyOn(getApi().results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        aggregate: {
          state: 'outdated',
          outdatedSubjectIds: [],
          cause: 'analysis-cohort',
        },
      },
      analysisCohortChange: { cause: 'membership' },
    })
    const subjects = cohort(2)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, aggregate: 'done' }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))

    expect(
      await screen.findByText(
        'The analysis cohort changed after this stage ran.',
      ),
    ).toBeVisible()
  })

  it('reads the inventory again when a QC verdict changes', async () => {
    const list = vi.spyOn(getApi().results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: {},
    })
    const subjects = cohort(2)
    const { rerender } = render(
      withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />),
    )
    await waitFor(() => expect(list).toHaveBeenCalled())
    const calls = list.mock.calls.length

    // A new array with the same verdicts is not a QC change.
    rerender(
      withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={[...subjects]} />),
    )
    await screen.findByLabelText('Run Reconstruction')
    expect(list.mock.calls.length).toBe(calls)

    rerender(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={subjects.map((subject, index) =>
            index === 0 ? { ...subject, qc: 'defer', qcRevision: 2 } : subject,
          )}
        />,
      ),
    )
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls))
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }))
  })

  it('names the subjects whose per-subject receipt is out of date', async () => {
    const api = getApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      stageCurrency: {
        brainfov: { state: 'outdated', outdatedSubjectIds: ['sub-002'] },
      },
    })
    const subjects = cohort(3)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, brainfov: 'done' }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))

    expect(await screen.findByText('1 out of date')).toHaveAttribute(
      'title',
      'The next run repeats Brain FOV preparation for this subject because its provenance receipt no longer matches the current inputs.',
    )
    expect(
      screen.getByTitle('2 subjects are done in Brain FOV preparation.'),
    ).toHaveTextContent(/^2 done$/)
  })

  it('hides View results on a stage no subject has completed', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={cohortWithReconCell('pending')}
        />,
      ),
    )
    await screen.findByLabelText('Run Reconstruction')
    expect(
      screen.queryByRole('button', {
        name: 'View results for Reconstruction',
      }),
    ).toBeNull()
  })

  it('does not expose raw stage output folders from renderer templates', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={cohortWithReconCell('done')}
        />,
      ),
    )
    await screen.findByRole('button', {
      name: 'View results for Reconstruction',
    })
    expect(
      screen.queryByRole('button', {
        name: 'Open folder for Reconstruction',
      }),
    ).toBeNull()
  })

  it('states the Clean up and Retry canceled cards as facts', async () => {
    // Every surface states that Allow live runs is off and says "turn on", and
    // Retry canceled states what it includes as a fact.
    vi.spyOn(getApi().runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-failed', 'failed')]),
    )
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('failed', 'oom_killed')}
        />,
      ),
    )

    expect(
      await screen.findByText(CLEANUP_SAFE_EXECUTION_OFF),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Reruns work a canceled run left unfinished.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow live runs' })).toBeNull()
    expect(screen.queryByText(/durable run|Explicitly/)).toBeNull()
  })

  it('should resume through the scoped workflow API', async () => {
    const api = getApi()
    const runSpy = vi.spyOn(api.pipeline, 'resumeWorkflow')
    const bootstrap = vi
      .spyOn(api.runtime, 'bootstrap')
      .mockResolvedValue(runtimeSnapshot([runSnapshot('run-failed', 'failed')]))
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('failed', 'oom_killed')}
        />,
      ),
    )
    await waitFor(() => expect(bootstrap).toHaveBeenCalled())
    await screen.findByText(CLEANUP_SAFE_EXECUTION_OFF)
    const resumeBtn = screen.getByRole('button', { name: 'Resume' })
    fireEvent.click(resumeBtn)
    const confirm = screen.getByRole('dialog', {
      name: 'Confirm resuming the run',
    })
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Review plan' }),
    )
    await waitFor(() => expect(runSpy).toHaveBeenCalled())
    const call = runSpy.mock.calls[0]
    if (!call) throw new Error('Call resume in this fixture.')
    expect(call[0].project.projectId).toBeTruthy()
  })

  it('suppresses Runs shortcuts while any dialog is open before focus moves', async () => {
    const api = getApi()
    const resumeSpy = vi.spyOn(api.pipeline, 'resumeWorkflow')
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-failed', 'failed')]),
    )
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('failed', 'oom_killed')}
        />,
      ),
    )
    await screen.findByRole('button', { name: /^Run all/ })

    document.body.focus()
    fireEvent.keyDown(window, { key: 'r' })
    expect(
      screen.getByRole('dialog', { name: 'Review the run plan?' }),
    ).toBeTruthy()

    document.body.focus()
    fireEvent.keyDown(window, { key: 'R' })
    await Promise.resolve()
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('opens the launch confirmation for r while a control outside the screen has focus', async () => {
    render(
      <>
        {withProvider(
          <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={cohort(1)} />,
        )}
        <button>Outside nav</button>
      </>,
    )
    await screen.findByRole('button', { name: /^Run all/ })

    const outside = screen.getByRole('button', { name: 'Outside nav' })
    outside.focus()
    expect(document.activeElement).toBe(outside)
    fireEvent.keyDown(window, { key: 'r' })
    expect(
      screen.getByRole('dialog', { name: 'Review the run plan?' }),
    ).toBeTruthy()
  })

  it('keeps the run report after the operator leaves Runs and comes back', async () => {
    const api = getApi()
    const startedMessage = 'Started run run-1: 1 job queued.'
    const started: WorkflowResult = {
      ...fulfilledOutcome('noop', startedMessage),
      runId: 'run-1',
      disposition: 'started',
      summary: { ...SUMMARY, started: 1, message: startedMessage },
    }
    vi.spyOn(api.pipeline, 'runWorkflow').mockResolvedValue(started)
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-1', 'running')]),
    )
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    function Shell({ showRuns }: { showRuns: boolean }): ReactNode {
      return showRuns ? (
        <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={cohort(1)} />
      ) : (
        <output>elsewhere</output>
      )
    }
    const { rerender } = render(withProvider(<Shell showRuns />))
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review plan' }))
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole('status')
          .some((node) => node.textContent?.includes(startedMessage)),
      ).toBe(true),
    )

    // Leave Runs while the run is still going; it fails in the meantime.
    rerender(withProvider(<Shell showRuns={false} />))
    expect(screen.getByText('elsewhere')).toBeInTheDocument()
    await act(async () => {
      publish?.({
        kind: 'job',
        job: makeJob({
          id: '#failed',
          stepKey: 'recon',
          subjectId: 'sub-001',
          status: 'failed',
          exitCode: 1,
          endedAt: 2,
          terminalReason: 'Increase available memory for recon-all.',
          runId: 'run-1',
        } as Partial<Job>),
        projectId: RUNS_PROJECT.projectId,
        projectEpoch: RUNS_PROJECT.epoch,
        sidecarGeneration: 1,
        sequence: 2,
        runId: 'run-1',
        at: 2,
      })
      publish?.({
        kind: 'run',
        run: runSnapshot('run-1', 'failed'),
        projectId: RUNS_PROJECT.projectId,
        projectEpoch: RUNS_PROJECT.epoch,
        sidecarGeneration: 1,
        sequence: 3,
        runId: 'run-1',
        at: 3,
      })
    })

    // Back on Runs, the failure is reported with its detail and Open Logs.
    rerender(withProvider(<Shell showRuns />))
    expect(
      await screen.findByText(
        /Run run-1 failed\. Reconstruction for sub-001 exited with code 1: Increase available memory for recon-all\. Open Logs for the captured output\./,
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open Logs' }),
    ).toBeInTheDocument()
  })

  it('states a started stage run by the jobs of its approved plan', async () => {
    // The sidecar's start message counts only the jobs the scheduler has not
    // started yet, so a 6-job run can read "5 jobs queued".
    const api = getApi()
    const message =
      'Started run run-af76d30e46dd: 5 jobs queued. Watch In flight here and the output in Logs.'
    const nodes: WorkflowNode[] = Array.from({ length: 6 }, (_, index) => ({
      nodeId: `recon:sub-00${index + 1}`,
      stepKey: 'recon',
      scope: 'subject',
      subjectId: `sub-00${index + 1}`,
      status: index < 2 ? 'planned' : 'waiting',
      dependencies: [],
    }))
    const base = fulfilledOutcome('noop', message)
    vi.spyOn(api.pipeline, 'runWorkflow').mockResolvedValue({
      ...base,
      runId: 'run-af76d30e46dd',
      disposition: 'started',
      plan: { ...base.plan, nodes },
      summary: { ...SUMMARY, planned: 6, message },
    })
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-af76d30e46dd', 'running')]),
    )
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    expect(
      await screen.findByText(
        'Reconstruction: run run-af76d30e46dd started with 6 jobs; In flight and Logs show their progress.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/queued\. Watch In flight/)).toBeNull()
  })

  it('follows a started run into its blocked outcome', async () => {
    const api = getApi()
    const blockedMessage =
      'Rerun pybrainage before clinical because no matching current provenance receipt exists.'
    const startedMessage = 'The run is queued.'
    const startedSummary: WorkflowSummary = {
      ...SUMMARY,
      started: 1,
      message: startedMessage,
    }
    const started: WorkflowResult = {
      ...fulfilledOutcome('noop', startedMessage),
      runId: 'run-1',
      disposition: 'started',
      summary: startedSummary,
    }
    vi.spyOn(api.pipeline, 'runWorkflow').mockResolvedValue(started)
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-1', 'running')]),
    )
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    render(
      withProvider(
        <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={cohort(1)} />,
      ),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review plan' }))
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole('status')
          .some((node) => node.textContent?.includes(startedMessage)),
      ).toBe(true),
    )

    // One job finishes, then the run ends blocked; the notice must follow it
    // and say what finished before what did not run.
    await act(async () => {
      publish?.({
        kind: 'job',
        job: makeJob({
          id: '#done',
          stepKey: 'recon',
          subjectId: 'sub-001',
          status: 'done',
          exitCode: 0,
          endedAt: 2,
          runId: 'run-1',
        } as Partial<Job>),
        projectId: RUNS_PROJECT.projectId,
        projectEpoch: RUNS_PROJECT.epoch,
        sidecarGeneration: 1,
        sequence: 2,
        runId: 'run-1',
        at: 2,
      })
      publish?.({
        kind: 'run',
        run: runSnapshot('run-1', 'blocked', {
          summary: { ...SUMMARY, blocked: 1, message: blockedMessage },
        }),
        projectId: RUNS_PROJECT.projectId,
        projectEpoch: RUNS_PROJECT.epoch,
        sidecarGeneration: 1,
        sequence: 3,
        runId: 'run-1',
        at: 3,
      })
    })

    // The readiness order reads as its fact.
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole('status')
          .some((node) =>
            node.textContent?.includes(
              'Run run-1 ended with 1 job finished and 1 job that did not run. PyBrainAge prediction has no current receipt for Clinical merge.',
            ),
          ),
      ).toBe(true),
    )
  })

  it('reports a failed run with stage, subject, exit code, reason, and Open Logs', async () => {
    const api = getApi()
    const startedMessage = 'Started run run-1: 1 job queued.'
    const started: WorkflowResult = {
      ...fulfilledOutcome('noop', startedMessage),
      runId: 'run-1',
      disposition: 'started',
      summary: { ...SUMMARY, started: 1, message: startedMessage },
    }
    vi.spyOn(api.pipeline, 'runWorkflow').mockResolvedValue(started)
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-1', 'running')]),
    )
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    render(
      withProvider(
        <>
          <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={cohort(1)} />
          <RouteProbe />
        </>,
      ),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review plan' }))
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole('status')
          .some((node) => node.textContent?.includes(startedMessage)),
      ).toBe(true),
    )

    const failedJob = makeJob({
      id: '#failed',
      stepKey: 'recon',
      subjectId: 'sub-001',
      status: 'failed',
      exitCode: 1,
      endedAt: 2,
      terminalReason: 'Inspect the failed reconstruction.',
      runId: 'run-1',
    } as Partial<Job>)
    // A recorded reason code reads as its fact, and a reason with no letter
    // or digit reads as no reason.
    const schedulerJob = makeJob({
      ...failedJob,
      id: '#scheduler',
      subjectId: 'sub-002',
      exitCode: null,
      terminalReason: 'scheduler_failure',
    })
    const separatorJob = makeJob({
      ...failedJob,
      id: '#separator',
      subjectId: 'sub-003',
      terminalReason: '-'.repeat(58),
    })
    await act(async () => {
      for (const [index, job] of [
        failedJob,
        schedulerJob,
        separatorJob,
      ].entries()) {
        publish?.({
          kind: 'job',
          job,
          projectId: RUNS_PROJECT.projectId,
          projectEpoch: RUNS_PROJECT.epoch,
          sidecarGeneration: 1,
          sequence: 2 + index,
          runId: 'run-1',
          at: 2,
        })
      }
      publish?.({
        kind: 'run',
        run: runSnapshot('run-1', 'failed'),
        projectId: RUNS_PROJECT.projectId,
        projectEpoch: RUNS_PROJECT.epoch,
        sidecarGeneration: 1,
        sequence: 5,
        runId: 'run-1',
        at: 3,
      })
    })

    // The notice names the newest failures first.
    const alert = await screen.findByText(
      /Run run-1 failed\. Reconstruction for sub-003 exited with code 1\. Reconstruction for sub-002 failed with no recorded exit code: Interrupted by a scheduler failure\. Reconstruction for sub-001 exited with code 1: Inspect the failed reconstruction\. Open Logs for the captured output\./,
    )
    expect(alert).toBeInTheDocument()
    expect(alert.textContent).not.toContain('scheduler_failure')
    expect(alert.textContent).not.toContain('---')
    fireEvent.click(screen.getByRole('button', { name: 'Open Logs' }))
    expect(screen.getByTestId('route-probe').textContent).toMatch(/^logs:/)
    // Open Logs hands the failed run over, so Logs focuses it and moves
    // keyboard focus to its Run list. A notice names a run, not a stage, so no
    // stage goes with it.
    expect(screen.getByTestId('route-probe')).toHaveAttribute(
      'data-logs-focus',
      'run-1',
    )
    expect(screen.getByTestId('route-probe')).toHaveAttribute(
      'data-logs-focus-stage',
      '',
    )
  })

  /**
   * Launch run-1 through Run all and return the runtime event publisher, so a
   * test can end the run the Runs screen is following.
   */
  async function followStartedRun(
    planNodes: WorkflowNode[] = [],
    probe: ReactNode = null,
  ): Promise<(event: RuntimeEvent) => void> {
    const api = getApi()
    const startedMessage = 'The run is queued.'
    const base = fulfilledOutcome('noop', startedMessage)
    const started: WorkflowResult = {
      ...base,
      runId: 'run-1',
      disposition: 'started',
      plan: { ...base.plan, nodes: planNodes },
      summary: { ...SUMMARY, started: 1, message: startedMessage },
    }
    vi.spyOn(api.pipeline, 'runWorkflow').mockResolvedValue(started)
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-1', 'running')]),
    )
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    render(
      withProvider(
        <>
          <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={cohort(1)} />
          {probe}
        </>,
      ),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review plan' }))
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole('status')
          .some((node) => node.textContent?.includes(startedMessage)),
      ).toBe(true),
    )
    // The restored run is active; In flight lists its planned nodes, or
    // states that its jobs have not appeared when its plan runs none.
    if (
      planNodes.some((node) =>
        ['planned', 'waiting', 'queued'].includes(node.status),
      )
    ) {
      await screen.findAllByText('Not started')
    } else {
      await screen.findByText(
        'A run is active; its jobs have not appeared yet.',
      )
    }
    const events = publish as ((event: RuntimeEvent) => void) | null
    if (!events) throw new Error('The runtime event listener is missing.')
    return events
  }

  function runEvent(run: RunSnapshot, sequence: number): RuntimeEvent {
    return {
      kind: 'run',
      run,
      projectId: RUNS_PROJECT.projectId,
      projectEpoch: RUNS_PROJECT.epoch,
      sidecarGeneration: 1,
      sequence,
      runId: run.runId,
      at: sequence,
    }
  }

  function jobEvent(job: Partial<Job>, sequence: number): RuntimeEvent {
    return {
      kind: 'job',
      job: makeJob({ endedAt: sequence, runId: 'run-1', ...job }),
      projectId: RUNS_PROJECT.projectId,
      projectEpoch: RUNS_PROJECT.epoch,
      sidecarGeneration: 1,
      sequence,
      runId: 'run-1',
      at: sequence,
    }
  }

  /** The page's status lines, to find the notice among them. */
  function statusTexts(): string[] {
    return screen.queryAllByRole('status').map((node) => node.textContent ?? '')
  }

  /** End the followed run-1 failed, with a failed Reconstruction job. */
  async function failFollowedRun(
    publish: (event: RuntimeEvent) => void,
  ): Promise<HTMLElement> {
    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#recon-failed',
            stepKey: 'recon',
            subjectId: 'sub-001',
            status: 'failed',
            exitCode: 3,
          },
          2,
        ),
      )
      publish(runEvent(runSnapshot('run-1', 'failed'), 3))
    })
    return screen.findByRole('alert')
  }

  it('dismisses a failed-run alert, which stays dismissed', async () => {
    // Like every other Runs notice, the failed-run alert can be dismissed.
    const publish = await followStartedRun()
    const alert = await failFollowedRun(publish)
    expect(alert).toHaveTextContent(/^Run run-1 failed\./)
    expect(
      within(alert).getByRole('button', { name: 'Open Logs' }),
    ).toBeEnabled()
    fireEvent.click(
      within(alert).getByRole('button', { name: 'Dismiss the failure' }),
    )
    expect(screen.queryByRole('alert')).toBeNull()
    // A later runtime change does not raise it again.
    await act(async () => {
      publish(runEvent(runSnapshot('run-1', 'failed', { endedAt: 4 }), 4))
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('states a failed run a later run recovered in place of its alert', async () => {
    // A Logs retry recovers the failed run, although Runs follows only runs
    // launched from Runs. The retry's planning line must not clear the Runs
    // feedback, or a closed review would drop the alert and a recovery would
    // never give way to the notice below.
    let logsRetryLine: ((pending: boolean) => void) | null = null
    function LogsRetry(): ReactNode {
      const { trackPlan } = useApp()
      useLayoutEffect(() => {
        logsRetryLine = trackPlan({
          label: 'Planning the retry...',
          waitReason: 'Supraspina is planning the retry.',
          card: null,
          keepsRunsFeedback: true,
        })
      }, [trackPlan])
      return null
    }
    const publish = await followStartedRun([], <LogsRetry />)
    await failFollowedRun(publish)
    // The retry plans, and its review closes with nothing run.
    act(() => logsRetryLine?.(true))
    act(() => logsRetryLine?.(false))
    expect(screen.getByRole('alert')).toHaveTextContent(/^Run run-1 failed\./)
    // The approved retry holds the line again until its launch settles.
    act(() => logsRetryLine?.(true))
    act(() => logsRetryLine?.(false))
    await act(async () => {
      publish({
        ...runEvent(runSnapshot('run-2', 'running', { startedAt: 5 }), 5),
      })
      publish({
        kind: 'job',
        job: makeJob({
          id: '#recon-retried',
          runId: 'run-2',
          stepKey: 'recon',
          subjectId: 'sub-001',
          status: 'done',
          exitCode: 0,
          startedAt: 5,
          endedAt: 6,
        }),
        projectId: RUNS_PROJECT.projectId,
        projectEpoch: RUNS_PROJECT.epoch,
        sidecarGeneration: 1,
        sequence: 6,
        runId: 'run-2',
        at: 6,
      })
      publish(
        runEvent(runSnapshot('run-2', 'done', { startedAt: 5, endedAt: 7 }), 7),
      )
    })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(statusTexts()).toContainEqual(
      expect.stringContaining(
        'Run run-1 failed; run-2 finished the work it left.',
      ),
    )
  })

  it.each([
    [
      'the current',
      'Reconstruction was interrupted, so this step did not run.',
    ],
  ])(
    'names the one stage a blocked run did not run from %s reason',
    async (_label, reason) => {
      const publish = await followStartedRun()

      // Reconstruction was interrupted, so the scheduler blocked ENIGMA QC and
      // recorded the block as a job; no job finished.
      await act(async () => {
        publish(
          jobEvent(
            {
              id: '#recon',
              stepKey: 'recon',
              subjectId: 'sub-001',
              status: 'interrupted',
            },
            2,
          ),
        )
        publish(
          jobEvent(
            {
              id: '#enigma',
              stepKey: 'enigma',
              status: 'blocked',
              terminalReason: reason,
            },
            3,
          ),
        )
        publish(
          runEvent(
            runSnapshot('run-1', 'blocked', {
              summary: {
                ...SUMMARY,
                started: 1,
                blocked: 1,
                message: `Resolve 1 blocked node. ${reason}`,
              },
            }),
            4,
          ),
        )
      })

      const notice =
        'Run run-1 ended with no job finished and 1 job that did not run. ENIGMA QC did not run because Reconstruction was interrupted.'
      await waitFor(() => expect(statusTexts()).toContain(notice))
      expect(statusTexts().join(' ')).not.toMatch(/Resolve|this step/)
    },
  )

  it('lists the stages a blocked run did not run when its reason fits one of several', async () => {
    const publish = await followStartedRun()

    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#enigma',
            stepKey: 'enigma',
            status: 'blocked',
            terminalReason:
              'Reconstruction was interrupted, so this step did not run.',
          },
          2,
        ),
      )
      publish(
        jobEvent(
          {
            id: '#outliers',
            stepKey: 'outliers',
            status: 'blocked',
            terminalReason: 'ENIGMA QC was blocked, so this step did not run.',
          },
          3,
        ),
      )
      publish(
        runEvent(
          runSnapshot('run-1', 'blocked', {
            summary: {
              ...SUMMARY,
              blocked: 2,
              message:
                'Resolve 2 blocked nodes. ENIGMA QC was blocked, so this step did not run. 1 more reason applies.',
            },
          }),
          4,
        ),
      )
    })

    await waitFor(() =>
      expect(statusTexts()).toContain(
        'Run run-1 ended with no job finished and 2 jobs that did not run. These stages did not run: ENIGMA QC, Histogram and outlier review.',
      ),
    )
    expect(statusTexts().join(' ')).not.toMatch(/Resolve|this step/)
  })

  it('counts the stages its plan blocked among those a blocked run did not run', async () => {
    // The plan blocked R analysis before the run started, so it never
    // became a job; the scheduler blocked ENIGMA QC while the run went on.
    const publish = await followStartedRun([
      {
        nodeId: 'final',
        stepKey: 'final',
        scope: 'cohort',
        subjectId: null,
        status: 'blocked',
        dependencies: [],
        reason: 'The clinical metadata file is missing.',
      },
    ])

    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#brainfov',
            stepKey: 'brainfov',
            subjectId: 'sub-001',
            status: 'done',
            exitCode: 0,
          },
          2,
        ),
      )
      publish(
        jobEvent(
          {
            id: '#recon',
            stepKey: 'recon',
            subjectId: 'sub-001',
            status: 'interrupted',
          },
          3,
        ),
      )
      publish(
        jobEvent(
          {
            id: '#enigma',
            stepKey: 'enigma',
            status: 'blocked',
            terminalReason:
              'Reconstruction was interrupted, so this step did not run.',
          },
          4,
        ),
      )
      // The summary quotes the first of its sorted reasons and counts the
      // other one.
      publish(
        runEvent(
          runSnapshot('run-1', 'blocked', {
            summary: {
              ...SUMMARY,
              started: 2,
              blocked: 2,
              message:
                'This pass runs 2 nodes; 2 blocked nodes will not run. Reconstruction was interrupted, so this step did not run. 1 more reason applies.',
            },
          }),
          5,
        ),
      )
    })

    await waitFor(() =>
      expect(statusTexts()).toContain(
        'Run run-1 ended with 1 job finished and 2 jobs that did not run. These stages did not run: ENIGMA QC, R analysis.',
      ),
    )
    expect(statusTexts().join(' ')).not.toMatch(/This pass runs|this step/)
  })

  it('lists the stages a blocked run did not run without a job', async () => {
    // The plan blocked Age metadata integration, and PyBrainAge prediction
    // with it. FreeSurfer then failed, the cohort-wide FastSurfer fallback
    // found conflicting Reconstruction output, and the sidecar blocked every
    // Reconstruction node and withheld the waiting ones without a job; only
    // the run's manifest records those stages.
    const publish = await followStartedRun([
      {
        nodeId: 'age',
        stepKey: 'age',
        scope: 'cohort',
        subjectId: null,
        status: 'blocked',
        dependencies: [],
        reason: 'The age metadata file is missing.',
      },
      {
        nodeId: 'pybrainage',
        stepKey: 'pybrainage',
        scope: 'cohort',
        subjectId: null,
        status: 'blocked',
        dependencies: ['age'],
        reason:
          'Age metadata integration was blocked, so this step did not run.',
      },
    ])
    const step = (
      id: number,
      key: ManifestStep['key'],
      status: ManifestStep['status'],
    ): ManifestStep => ({
      id,
      key,
      status,
      subjects: 1,
      failed: 0,
      durationSec: 0,
    })
    const manifest: RunManifest = {
      runId: 'run-1',
      startedAt: '2026-09-25T10:00:00.000Z',
      endedAt: '2026-09-25T10:05:00.000Z',
      user: '[REDACTED]',
      host: '[REDACTED]',
      git: { repo: '', sha: '', dirty: false },
      configSha256: '0'.repeat(64),
      steps: [
        step(1, 'brainfov', 'done'),
        step(3, 'recon', 'blocked'),
        step(4, 'enigma', 'withheld'),
        step(6, 'features', 'withheld'),
        step(7, 'age', 'blocked'),
        step(8, 'pybrainage', 'blocked'),
      ],
      tools: {},
    }
    const forRun = vi
      .spyOn(getApi().manifest, 'forRun')
      .mockResolvedValue(manifest)

    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#brainfov',
            stepKey: 'brainfov',
            subjectId: 'sub-001',
            status: 'done',
            exitCode: 0,
          },
          2,
        ),
      )
      publish(
        jobEvent(
          {
            id: '#recon',
            stepKey: 'recon',
            subjectId: 'sub-001',
            status: 'failed',
            exitCode: 1,
            backend: 'freesurfer',
            role: 'superseded-primary',
          },
          3,
        ),
      )
      publish(
        runEvent(
          runSnapshot('run-1', 'blocked', {
            summary: {
              ...SUMMARY,
              started: 1,
              blocked: 5,
              message:
                'This pass runs 1 node; 5 blocked nodes will not run. Age metadata integration was blocked, so this step did not run. 3 more reasons apply.',
            },
          }),
          4,
        ),
      )
    })

    await waitFor(() =>
      expect(statusTexts()).toContain(
        'Run run-1 ended with 1 job finished and 5 jobs that did not run. These stages did not run: Reconstruction, ENIGMA QC, FreeSurfer feature extraction, Age metadata integration, PyBrainAge prediction.',
      ),
    )
    expect(forRun).toHaveBeenCalledWith({
      project: RUNS_PROJECT,
      runId: 'run-1',
    })
  })

  it('names the stages the plan and jobs show when the manifest cannot be read', async () => {
    const publish = await followStartedRun()
    vi.spyOn(getApi().manifest, 'forRun').mockRejectedValue(
      new Error('The run manifest is unreadable.'),
    )

    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#enigma',
            stepKey: 'enigma',
            status: 'blocked',
            terminalReason:
              'Reconstruction was interrupted, so this step did not run.',
          },
          2,
        ),
      )
      publish(
        runEvent(
          runSnapshot('run-1', 'blocked', {
            summary: {
              ...SUMMARY,
              blocked: 1,
              message:
                'Resolve 1 blocked node. Reconstruction was interrupted, so this step did not run.',
            },
          }),
          3,
        ),
      )
    })

    await waitFor(() =>
      expect(statusTexts()).toContain(
        'Run run-1 ended with no job finished and 1 job that did not run. ENIGMA QC did not run because Reconstruction was interrupted.',
      ),
    )
  })

  it('names the subject a blocked run left with an output conflict', async () => {
    // The output conflict reason names no subject, so the notice names the
    // subject.
    const conflict =
      'Choose a fresh derivatives namespace because detector-complete Reconstruction output has no matching current receipt; preserve the existing tree.'
    const publish = await followStartedRun([
      {
        nodeId: 'recon-116',
        stepKey: 'recon',
        scope: 'subject',
        subjectId: 'sub-901',
        status: 'planned',
        dependencies: [],
        reason: 'No earlier run left a receipt for it.',
      },
      {
        nodeId: 'recon-302',
        stepKey: 'recon',
        scope: 'subject',
        subjectId: 'sub-902',
        status: 'blocked',
        dependencies: [],
        reason: conflict,
      },
    ])

    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#recon-116',
            stepKey: 'recon',
            subjectId: 'sub-901',
            status: 'done',
            exitCode: 0,
          },
          2,
        ),
      )
      publish(
        runEvent(
          runSnapshot('run-1', 'blocked', {
            summary: {
              ...SUMMARY,
              started: 1,
              blocked: 1,
              message: `This pass runs 1 node; 1 blocked node will not run. ${conflict}`,
            },
          }),
          3,
        ),
      )
    })

    await waitFor(() =>
      expect(statusTexts()).toContain(
        `Run run-1 ended with 1 job finished and 1 job that did not run. Reconstruction for sub-902: ${conflict}`,
      ),
    )
  })

  it('names the subjects of a reason the scheduler recorded on blocked jobs', async () => {
    const reason =
      'Resolve the integrity check failure: Recheck unknown detector evidence.'
    const publish = await followStartedRun()

    await act(async () => {
      for (const [index, subjectId] of ['sub-002', 'sub-001'].entries()) {
        publish(
          jobEvent(
            {
              id: `#deface-${subjectId}`,
              stepKey: 'deface',
              subjectId,
              status: 'blocked',
              terminalReason: reason,
            },
            2 + index,
          ),
        )
      }
      publish(
        runEvent(
          runSnapshot('run-1', 'blocked', {
            summary: {
              ...SUMMARY,
              blocked: 2,
              message: `Resolve 2 blocked nodes. ${reason}`,
            },
          }),
          4,
        ),
      )
    })

    await waitFor(() =>
      expect(statusTexts()).toContain(
        'Run run-1 ended with no job finished and 2 jobs that did not run. Optional defacing for sub-001 and sub-002: The integrity check failed: The detector evidence is unknown.',
      ),
    )
  })

  it.each([
    [4, '1 more job failed.'],
    [5, '2 more jobs failed.'],
  ] as const)(
    'names three of %i failed jobs and counts the rest',
    async (count, more) => {
      const publish = await followStartedRun()

      await act(async () => {
        for (let index = 1; index <= count; index += 1) {
          publish(
            jobEvent(
              {
                id: `#failed-${index}`,
                subjectId: `sub-00${index}`,
                status: 'failed',
                exitCode: 1,
              },
              1 + index,
            ),
          )
        }
        publish(runEvent(runSnapshot('run-1', 'failed'), 2 + count))
      })

      // The newest failures come first; the notice names three.
      const named = Array.from(
        { length: 3 },
        (_, offset) =>
          `Reconstruction for sub-00${count - offset} exited with code 1.`,
      ).join(' ')
      expect(
        await screen.findByText(
          `Run run-1 failed. ${named} ${more} Open Logs for the captured output.`,
        ),
      ).toBeInTheDocument()
      expect(screen.queryByText(/sub-001 exited/)).toBeNull()
    },
  )

  it('states a finished run once rather than repeating its summary', async () => {
    const publish = await followStartedRun()

    await act(async () => {
      publish(
        runEvent(
          runSnapshot('run-1', 'done', {
            summary: { ...SUMMARY, started: 1, message: 'The run finished.' },
          }),
          2,
        ),
      )
    })

    await waitFor(() =>
      expect(
        screen
          .queryAllByRole('status')
          .some((node) => node.textContent === 'Run run-1 finished.'),
      ).toBe(true),
    )
    expect(screen.queryByText(/The run finished\./)).toBeNull()
  })

  it.each([
    [
      'interrupted',
      1,
      {},
      [],
      'Run run-1 was interrupted. 1 job completed before the run ended. Open Logs for the captured output.',
    ],
    [
      'persistence-error',
      0,
      {},
      [],
      'Run run-1 stopped because Supraspina could not persist its state. No job completed. Open Logs for the captured output.',
    ],
    [
      // The Reconstruction job's own commit failed, so its node failed, and
      // the sidecar withheld the waiting Defacing node.
      'persistence-error',
      0,
      { started: 1, blocked: 1 },
      [
        planNode('recon', 'sub-001', 'planned'),
        planNode('deface', 'sub-001', 'waiting', ['recon:sub-001']),
      ],
      'Run run-1 stopped because Supraspina could not persist its state. No job completed. 1 job did not run. Open Logs for the captured output.',
    ],
    [
      // A cancellation Supraspina could not persist marks the running node and
      // the waiting one interrupted.
      'persistence-error',
      0,
      {},
      [
        planNode('recon', 'sub-001', 'planned'),
        planNode('deface', 'sub-001', 'waiting', ['recon:sub-001']),
      ],
      'Run run-1 stopped because Supraspina could not persist its state. No job completed. 2 jobs were interrupted. Open Logs for the captured output.',
    ],
    [
      // Settled after a restart: one node failed, the one no process ran is
      // interrupted, and the plan blocked R analysis.
      'failed',
      0,
      { started: 1, blocked: 1 },
      [
        planNode('recon', 'sub-001', 'planned'),
        planNode('recon', 'sub-002', 'planned'),
        planNode('final', null, 'blocked'),
      ],
      'Run run-1 failed. No job completed. 1 job was interrupted and 1 job did not run. Open Logs for the captured output.',
    ],
    [
      // A plan with fewer nodes than the summary counts does not describe
      // the run, so no count is stated rather than a partial one.
      'interrupted',
      0,
      { blocked: 2 },
      [],
      'Run run-1 was interrupted. No job completed. Open Logs for the captured output.',
    ],
  ] as const)(
    'states how a %s run ended and what completed before it',
    async (status, completed, counts, nodes, text) => {
      const publish = await followStartedRun([...nodes])

      await act(async () => {
        if (completed > 0) {
          publish({
            kind: 'job',
            job: makeJob({
              id: '#done',
              subjectId: 'sub-001',
              status: 'done',
              exitCode: 0,
              endedAt: 2,
              runId: 'run-1',
            }),
            projectId: RUNS_PROJECT.projectId,
            projectEpoch: RUNS_PROJECT.epoch,
            sidecarGeneration: 1,
            sequence: 2,
            runId: 'run-1',
            at: 2,
          })
        }
        publish(
          runEvent(
            runSnapshot('run-1', status, {
              summary: { ...SUMMARY, ...counts },
            }),
            3,
          ),
        )
      })

      expect(await screen.findByText(text)).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Open Logs' }),
      ).toBeInTheDocument()
    },
  )

  it("states a failed Reconstruction's cause in the failed-run notice", async () => {
    // The closing line of recon-all alone hides the failing step.
    const publish = await followStartedRun([
      planNode('recon', 'sub-101', 'planned'),
    ])

    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#failed',
            stepKey: 'recon',
            subjectId: 'sub-101',
            status: 'failed',
            exitCode: 1,
            terminalReason:
              'recon-all -s sub-101 exited with ERRORS at Thu Jan  1 22:15:33 UTC 2026',
            failureCause: 'label-cortex failed: found no voxels matching id 1',
          },
          2,
        ),
      )
      publish(
        runEvent(
          runSnapshot('run-1', 'failed', {
            summary: { ...SUMMARY, started: 1 },
          }),
          3,
        ),
      )
    })

    expect(
      await screen.findByText(
        'Run run-1 failed. Reconstruction for sub-101 exited with code 1: label-cortex failed: found no voxels matching id 1. Open Logs for the captured output.',
      ),
    ).toBeInTheDocument()
  })

  it('counts the jobs a failed run did not run, including those without a job', async () => {
    // Stop on first error: Reconstruction failed for sub-001, and the
    // scheduler withheld the queued Reconstruction job and the two waiting
    // nodes. Only the queued one had a job; the run summary counts all three.
    const publish = await followStartedRun([
      planNode('recon', 'sub-001', 'planned'),
      planNode('recon', 'sub-002', 'planned'),
      planNode('deface', 'sub-001', 'waiting', ['recon:sub-001']),
      planNode('deface', 'sub-002', 'waiting', ['recon:sub-002']),
    ])
    const forRun = vi.spyOn(getApi().manifest, 'forRun')

    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#failed',
            stepKey: 'recon',
            subjectId: 'sub-001',
            status: 'failed',
            exitCode: 1,
            terminalReason: 'The process exited with code 1.',
          },
          2,
        ),
      )
      publish(
        jobEvent(
          {
            id: '#withheld',
            stepKey: 'recon',
            subjectId: 'sub-002',
            status: 'withheld',
            terminalReason: 'failure_policy_withheld',
          },
          3,
        ),
      )
      publish(
        runEvent(
          runSnapshot('run-1', 'failed', {
            summary: {
              ...SUMMARY,
              started: 1,
              blocked: 3,
              message:
                'This pass runs 1 node; 3 blocked nodes will not run. Withheld by the failure policy after an earlier failure.',
            },
          }),
          4,
        ),
      )
    })

    expect(
      await screen.findByText(
        'Run run-1 failed. Reconstruction for sub-001 exited with code 1: The process exited with code 1. 3 jobs did not run. Open Logs for the captured output.',
      ),
    ).toBeInTheDocument()
    // The count comes from the run's summary; no manifest read is needed.
    expect(forRun).not.toHaveBeenCalled()
  })

  it('counts the jobs an interrupted run stopped apart from those that did not run', async () => {
    // A scheduler failure marks every unfinished node interrupted: the
    // running Reconstruction for sub-002 and the Defacing and ENIGMA QC
    // nodes that never started alike. The summary counts none of them, only
    // the Brain FOV node the plan blocked, so the plan's node count gives the
    // interrupted ones; which of them started, no snapshot says.
    const publish = await followStartedRun([
      planNode('recon', 'sub-001', 'planned'),
      planNode('recon', 'sub-002', 'planned'),
      planNode('deface', 'sub-002', 'waiting', ['recon:sub-002']),
      planNode('enigma', null, 'waiting', ['recon:sub-001', 'recon:sub-002']),
      planNode('brainfov', 'sub-003', 'blocked'),
    ])

    await act(async () => {
      publish(
        jobEvent(
          {
            id: '#done',
            stepKey: 'recon',
            subjectId: 'sub-001',
            status: 'done',
            exitCode: 0,
            endedAt: 2,
          },
          2,
        ),
      )
      publish(
        jobEvent(
          {
            id: '#running',
            stepKey: 'recon',
            subjectId: 'sub-002',
            status: 'interrupted',
            terminalReason: 'scheduler_failure',
            endedAt: 3,
          },
          3,
        ),
      )
      publish(
        runEvent(
          runSnapshot('run-1', 'interrupted', {
            summary: {
              ...SUMMARY,
              started: 1,
              blocked: 1,
              message:
                'This pass runs 1 node; 1 blocked node will not run. Input QC failed, so this step did not run.',
            },
          }),
          4,
        ),
      )
    })

    expect(
      await screen.findByText(
        'Run run-1 was interrupted. 1 job completed before the run ended. 3 jobs were interrupted and 1 job did not run. Open Logs for the captured output.',
      ),
    ).toBeInTheDocument()
  })

  it('offers no recovery for a failed run that a later run superseded', async () => {
    const api = getApi()
    const resumeSpy = vi.spyOn(api.pipeline, 'resumeWorkflow')
    const retrySpy = vi.spyOn(api.pipeline, 'retryWorkflow')
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [
          runSnapshot('run-8407b948c62b', 'failed', {
            startedAt: FAILED_RUN_STARTED,
            endedAt: FAILED_RUN_STARTED + 1_000,
          }),
          runSnapshot('run-9a3301d38242', 'done', {
            startedAt: FAILED_RUN_STARTED + 60_000,
            endedAt: FAILED_RUN_STARTED + 120_000,
          }),
        ],
        // The later run finished another stage; the failed reconstruction is
        // still undone.
        [
          makeJob({
            id: '#failed-recon',
            runId: 'run-8407b948c62b',
            subjectId: 'sub-001',
            status: 'failed',
          }),
          makeJob({
            id: '#later-brainfov',
            runId: 'run-9a3301d38242',
            stepKey: 'brainfov',
            subjectId: 'sub-001',
            status: 'done',
          }),
        ],
      ),
    )
    render(
      withProvider(<RunsScreen subjects={cohort(1)} />, {
        safeExecution: true,
      }),
    )

    const superseded = `run-9a3301d38242 finished after the failed run of ${shortRunTime(FAILED_RUN_STARTED)}.`
    const resume = await screen.findByRole('button', { name: 'Resume' })
    const clean = screen.getByRole('button', { name: 'Clean up and retry...' })
    // A reason that only says there is nothing to act on stays in the
    // action's tooltip rather than on the card.
    await waitFor(() =>
      expect(resume.closest('[title]')).toHaveAttribute(
        'title',
        `Nothing to resume: ${superseded} Shortcut: Shift+R.`,
      ),
    )
    expect(clean.closest('[title]')).toHaveAttribute(
      'title',
      `Nothing to clean up: ${superseded}`,
    )
    expect(screen.queryByText(`Nothing to resume: ${superseded}`)).toBeNull()
    expect(screen.queryByText(`Nothing to clean up: ${superseded}`)).toBeNull()
    expect(resume).toBeDisabled()
    expect(clean).toBeDisabled()

    fireEvent.click(resume)
    fireEvent.click(clean)
    fireEvent.keyDown(window, { key: 'R' })
    await Promise.resolve()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(retrySpy).not.toHaveBeenCalled()
  })

  it('offers no retry or resume for runs that later runs already recovered', async () => {
    // A canceled run retried to completion offers no "Retry canceled...", and
    // Resume does not cite an interrupted run that a later Resume finished.
    const cohortJob = (
      id: string,
      runId: string,
      stepKey: Job['stepKey'],
      status: Job['status'],
    ): Job => makeJob({ id, runId, stepKey, subjectId: null, status })
    const stages = ['enigma', 'features', 'aggregate'] as const
    const runs = [
      runSnapshot('run-73c7e1979332', 'interrupted', {
        startedAt: 1790375242640,
        endedAt: 1790375270667,
      }),
      runSnapshot('run-b22abc08d02d', 'done', {
        startedAt: 1790375936499,
        endedAt: 1790375948769,
      }),
      runSnapshot('run-5edb9a689625', 'cancelled', {
        startedAt: 1790376037856,
        endedAt: 1790376047033,
      }),
      runSnapshot('run-ecfbfb6a0c6c', 'done', {
        startedAt: 1790376120925,
        endedAt: 1790376133068,
      }),
    ]
    const jobs = [
      ['run-73c7e1979332', 'interrupted'],
      ['run-b22abc08d02d', 'done'],
      ['run-5edb9a689625', 'cancelled'],
      ['run-ecfbfb6a0c6c', 'done'],
    ].flatMap(([runId, status]) =>
      stages.map((stepKey) =>
        cohortJob(
          `#${runId}-${stepKey}`,
          runId as string,
          stepKey,
          status as Job['status'],
        ),
      ),
    )
    vi.spyOn(getApi().runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(runs, jobs),
    )
    render(
      withProvider(<RunsScreen subjects={cohort(1)} />, {
        safeExecution: true,
      }),
    )

    const resume = await screen.findByRole('button', { name: 'Resume' })
    const retry = screen.getByRole('button', { name: 'Retry canceled...' })
    // Both reasons only say there is nothing to act on, so they stay in the
    // actions' tooltips.
    await waitFor(() =>
      expect(resume.closest('[title]')).toHaveAttribute(
        'title',
        'Nothing to resume: no failed or interrupted run is waiting for recovery. Shortcut: Shift+R.',
      ),
    )
    expect(retry.closest('[title]')).toHaveAttribute(
      'title',
      'Nothing to retry: no canceled run is waiting for a retry.',
    )
    expect(screen.queryByText(/^Nothing to (resume|retry)/)).toBeNull()
    expect(resume).toBeDisabled()
    expect(retry).toBeDisabled()
    expect(screen.queryByTitle(/after the interrupted run/)).toBeNull()
    expect(screen.queryByText(/after the interrupted run/)).toBeNull()
  })

  it('still offers Retry canceled when a later run redid only the canceled jobs', async () => {
    // A Run all canceled while sub-002's reconstruction ran also cancels the
    // five waiting cohort stages, which have no job. A later
    // Reconstruction-only run redoes sub-002, but those stages never ran, so
    // "Retry canceled..." stays.
    const subjects = ['sub-001', 'sub-002']
    vi.spyOn(getApi().runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [
          runSnapshot('run-cancelledAll', 'cancelled', {
            startedAt: 1_000,
            endedAt: 2_000,
            analysisSubjectIds: subjects,
            selectedSubjectIds: subjects,
            summary: { ...SUMMARY, started: 7 },
          }),
          runSnapshot('run-reconOnly', 'done', {
            startedAt: 3_000,
            endedAt: 4_000,
            analysisSubjectIds: subjects,
            selectedSubjectIds: ['sub-002'],
            summary: { ...SUMMARY, started: 1 },
          }),
        ],
        [
          makeJob({
            id: '#canceled-recon-1',
            runId: 'run-cancelledAll',
            subjectId: 'sub-001',
            status: 'done',
          }),
          makeJob({
            id: '#canceled-recon-2',
            runId: 'run-cancelledAll',
            subjectId: 'sub-002',
            status: 'cancelled',
          }),
          makeJob({
            id: '#later-recon-2',
            runId: 'run-reconOnly',
            subjectId: 'sub-002',
            status: 'done',
          }),
        ],
      ),
    )
    render(withProvider(<RunsScreen subjects={cohort(2)} />))

    const retry = await screen.findByRole('button', {
      name: 'Retry canceled...',
    })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.queryByText(/^Nothing to retry/)).toBeNull()
  })

  it('confirms the newest failed run before resuming and plans nothing on Cancel', async () => {
    const api = getApi()
    const resumeSpy = vi.spyOn(api.pipeline, 'resumeWorkflow')
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([
        runSnapshot('run-older', 'done', { startedAt: 1, endedAt: 2 }),
        runSnapshot('run-newest', 'failed', { startedAt: 3, endedAt: 4 }),
      ]),
    )
    render(withProvider(<RunsScreen subjects={cohort(1)} />))

    const resume = await screen.findByRole('button', { name: 'Resume' })
    await waitFor(() => expect(resume).toBeEnabled())
    fireEvent.click(resume)

    const confirm = screen.getByRole('dialog', {
      name: 'Confirm resuming the run',
    })
    expect(confirm).toHaveTextContent(
      `Resume runs the outstanding jobs from the failed run started ${runTimestampLabel(3)} (1 subject). Successful jobs stay skipped.`,
    )
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await Promise.resolve()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(resumeSpy).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'R' })
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Confirm resuming the run' }),
      ).getByRole('button', { name: 'Review plan' }),
    )
    await waitFor(() => expect(resumeSpy).toHaveBeenCalled())
    for (const [request] of resumeSpy.mock.calls) {
      expect(request.runId).toBe('run-newest')
    }
  })

  it('should not launch any run when Resume failed has nothing to resume', async () => {
    const api = getApi()
    const runSpy = vi.spyOn(api.pipeline, 'resumeWorkflow')
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('done')}
        />,
      ),
    )
    const resumeBtn = await screen.findByRole('button', { name: 'Resume' })
    fireEvent.click(resumeBtn)
    await Promise.resolve()
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('should disable run actions when the config is dirty', async () => {
    render(withProvider(<RunsScreen dirty />))
    const runAll = await screen.findByRole('button', { name: /^Run all/ })
    expect((runAll as HTMLButtonElement).disabled).toBe(true)
    // The banner states the fact without the internal invariant key, which
    // stays on the banner as a data attribute.
    const banner = screen.getByText(
      'The configuration has unsaved changes, and runs start only after it is saved.',
    )
    expect(banner.closest('[role="status"]')).toHaveAttribute(
      'data-invariant',
      'no-run-while-dirty',
    )
    expect(screen.queryByText(/\(no-run-while-dirty\)/)).toBeNull()
  })

  it('shows a planning indicator while a launch is in progress', async () => {
    const api = getApi()
    let release!: (value: WorkflowResult) => void
    vi.spyOn(api.pipeline, 'planWorkflow').mockImplementationOnce(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          release = resolve
        }),
    )
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm the Reconstruction launch',
    })
    // The confirmation says a plan review follows before anything runs.
    expect(dialog).toHaveTextContent(
      'If anything would run, the plan opens for review. Dry run is on, so nothing executes.',
    )
    expect(dialog).not.toHaveTextContent('Supraspina computes the plan next.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review plan' }))
    // The progress line shows in the page banner and on the card that
    // started the launch; only the page banner announces it.
    expect(
      await screen.findAllByText('Planning Reconstruction...'),
    ).toHaveLength(2)
    const announced = liveRegionsWith('Planning Reconstruction...')
    expect(announced).toHaveLength(1)
    expect(announced[0]).toHaveAttribute('role', 'status')
    expect(announced[0]).toHaveAttribute('aria-live', 'polite')
    expect(
      screen
        .getAllByRole('status')
        .filter((node) =>
          node.textContent?.includes('Planning Reconstruction...'),
        ),
    ).toHaveLength(1)
    expect(
      (screen.getByRole('button', { name: /^Run all/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    await act(async () => {
      release(fulfilledOutcome('noop', 'Continue because nothing is required.'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        screen.queryByText('Planning Reconstruction...'),
      ).not.toBeInTheDocument(),
    )
  })

  it('holds every launch and recovery control with a reason while a plan is pending', async () => {
    const api = getApi()
    let release!: (value: WorkflowResult) => void
    vi.spyOn(api.pipeline, 'planWorkflow').mockImplementationOnce(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          release = resolve
        }),
    )
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([
        runSnapshot('run-cancelled', 'cancelled', { startedAt: 1, endedAt: 2 }),
        runSnapshot('run-failed', 'failed', { startedAt: 3, endedAt: 4 }),
      ]),
    )
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />, {
        safeExecution: true,
      }),
    )
    const held = ['Resume', 'Retry canceled...', 'Clean up and retry...']
    const clean = await screen.findByRole('button', {
      name: 'Clean up and retry...',
    })
    await waitFor(() => expect(clean).toBeEnabled())
    for (const name of held) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }

    fireEvent.click(screen.getByRole('button', { name: /^Run all/ }))
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Review the run plan?' }),
      ).getByRole('button', { name: 'Review plan' }),
    )

    // The progress shows in the page banner and again on the Run all card;
    // the banner is the one polite status region that announces it.
    const progress = await screen.findAllByText('Planning the workflow...')
    expect(progress).toHaveLength(2)
    const announced = liveRegionsWith('Planning the workflow...')
    expect(announced).toHaveLength(1)
    expect(announced[0]).toHaveAttribute('role', 'status')
    expect(announced[0]).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: /^Run all/ })).toBeDisabled()
    for (const name of held) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
    // The held cards and the stage cards name the plan they wait for.
    expect(
      screen.getAllByText('Supraspina is planning the workflow.').length,
    ).toBeGreaterThanOrEqual(held.length + 1)
    fireEvent.keyDown(window, { key: 'r' })
    fireEvent.keyDown(window, { key: 'R' })
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => {
      release(fulfilledOutcome('noop', 'No work is scheduled.'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled(),
    )
    expect(
      screen.queryByText('Supraspina is planning the workflow.'),
    ).toBeNull()
  })

  it('offers the Allow live runs toggle beside Dry run and says what it gates', async () => {
    const live = structuredClone(DEFAULT_PROJECT_CONFIG)
    live.runtime.dryRun = false
    const { rerender } = render(withProvider(<RunsScreen cfg={live} />))
    await screen.findByRole('button', { name: /^Run all/ })
    expect(
      screen.getByText(
        'Allow live runs is off, so a live plan opens read-only and cannot be authorized. Turn it on to execute, or turn on Dry run first to preview.',
      ),
    ).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Allow live runs' })
    expect(toggle.closest('[title]')).toHaveAttribute(
      'title',
      'Off keeps runs dry. On lasts for this session and resets to off on every launch.',
    )
    fireEvent.click(toggle)
    // The normal state states no line; the tooltip explains the toggle.
    await waitFor(() =>
      expect(
        screen.queryByText(/live plan opens read-only/),
      ).not.toBeInTheDocument(),
    )
    rerender(withProvider(<RunsScreen cfg={DEFAULT_PROJECT_CONFIG} />))
    expect(
      screen.queryByText(/live plan opens read-only/),
    ).not.toBeInTheDocument()
  })

  it('names the read-only plan in the launch dialog and turns Allow live runs on there', async () => {
    // Allow live runs resets to off on every relaunch, so the first live
    // launch can only show its plan read-only.
    const live = structuredClone(RESOLVED_CFG)
    live.runtime.dryRun = false
    const { rerender } = render(
      withProvider(<RunsScreen cfg={live} subjects={cohort(1)} />),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    expect(dialog).toHaveTextContent(
      'Allow live runs is off for this session. Turn it on, then save the project to authorize and run live.',
    )
    expect(dialog).toHaveTextContent(
      'If anything would run, the plan opens read-only, because Allow live runs is off.',
    )

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Allow live runs' }),
    )
    expect(
      screen.getByRole('switch', { name: 'Allow live runs', hidden: true }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(dialog).not.toHaveTextContent(/Allow live runs is off/)

    // Turning it on leaves the project unsaved by design; the dialog then
    // asks for the save a live run needs.
    rerender(withProvider(<RunsScreen cfg={live} subjects={cohort(1)} dirty />))
    expect(
      screen.getByRole('dialog', { name: 'Review the run plan?' }),
    ).toHaveTextContent(
      'Allow live runs is on for this session. Save the project to run live.',
    )

    // The toolbar Save sits behind the modal, so the notice offers the save.
    const originalSave = getApi().project.save
    let finishSave!: () => void
    const saveSpy = vi
      .spyOn(getApi().project, 'save')
      .mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          finishSave = resolve
        })
        return originalSave(...args)
      })
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Review the run plan?' }),
      ).getByRole('button', { name: 'Save project' }),
    )
    await waitFor(() => expect(saveSpy).toHaveBeenCalled())
    // While the save runs, the button states it rather than ordering a wait.
    expect(
      within(
        screen.getByRole('dialog', { name: 'Review the run plan?' }),
      ).getByRole('button', { name: 'Saving...' }),
    ).toBeDisabled()
    await act(async () => {
      finishSave()
      await Promise.resolve()
    })
  })

  it('disables every cohort run action with a clear reason when no subjects exist', async () => {
    const api = getApi()
    const runSpy = vi.spyOn(api.pipeline, 'runWorkflow')
    render(
      withProvider(<RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={[]} />),
    )
    await screen.findByText('No eligible subjects to run.')
    // The screen banner owns the reason exactly once; cards and buttons do not
    // repeat it.
    expect(
      await screen.findAllByText(
        'Add subjects to the configured data root before running.',
      ),
    ).toHaveLength(1)
    const runAll = await screen.findByRole('button', { name: /^Run all/ })
    expect((runAll as HTMLButtonElement).disabled).toBe(true)
    expect(runAll.getAttribute('title')).toBeNull()
    const resume = screen.getByText('Resume').closest('button')
    expect((resume as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'r' })
    fireEvent.keyDown(window, { key: 'R' })
    await Promise.resolve()
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('should disable a stage Run and show the reason when its tools are blocked', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
          blockers={[
            {
              key: 'recon',
              reason: 'Install or configure a Reconstruction backend.',
            },
          ]}
        />,
      ),
    )
    const reconRun = await screen.findByRole('button', {
      name: 'Run Reconstruction',
    })
    expect((reconRun as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText('Install or configure a Reconstruction backend.'),
    ).toBeTruthy()
  })

  it('offers the asset rebuild on the blocked ENIGMA card and authorizes it only from its confirm', async () => {
    const api = getApi()
    const authorize = vi.spyOn(api.execution, 'authorize')
    const optInInstall = vi.spyOn(api.env, 'optInInstall')
    const restored = assetRebuildReport(false)
    vi.spyOn(api.env, 'check').mockResolvedValue(restored)
    const onEnvReport = vi.fn()
    const report = assetRebuildReport(true)
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={cohortWithReconCell('done')}
          envReport={report}
          blockers={enigmaBlockers(report)}
          onEnvReport={onEnvReport}
        />,
        { safeExecution: true },
      ),
    )

    const rebuild = await screen.findByRole('button', {
      name: 'Rebuild assets for ENIGMA QC',
    })
    expect(
      screen.getByText(
        'Rebuild the scientific assets to restore the ENIGMA QC assets.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run ENIGMA QC' })).toBeDisabled()
    // Only the card that the restored checks block offers the rebuild.
    expect(
      screen.getAllByRole('button', { name: /^Rebuild assets for / }),
    ).toHaveLength(1)

    fireEvent.click(rebuild)
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm the rebuild of Reviewed scientific assets',
    })
    expect(dialog).toHaveTextContent('Restores ENIGMA QC assets.')
    expect(authorize).not.toHaveBeenCalled()
    expect(optInInstall).not.toHaveBeenCalled()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Authorize rebuild' }),
    )

    await waitFor(() =>
      expect(optInInstall).toHaveBeenCalledWith(
        expect.objectContaining({ checkId: 'scientific_assets' }),
      ),
    )
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'opt-in-install' }),
    )
    // The finished rebuild re-checks the environment for the shell.
    await waitFor(() => expect(onEnvReport).toHaveBeenCalledWith(restored), {
      timeout: 4000,
    })
  })

  it('holds the asset rebuild behind Allow live runs in its confirm', async () => {
    const authorize = vi.spyOn(getApi().execution, 'authorize')
    const report = assetRebuildReport(true)
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={cohortWithReconCell('done')}
          envReport={report}
          blockers={enigmaBlockers(report)}
        />,
      ),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Rebuild assets for ENIGMA QC',
      }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm the rebuild of Reviewed scientific assets',
    })
    expect(dialog).toHaveTextContent(
      'Allow live runs to rebuild the scientific assets.',
    )
    const confirm = within(dialog).getByRole('button', {
      name: 'Authorize rebuild',
    })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('offers no asset rebuild when the assets must be downloaded', async () => {
    const report = assetRebuildReport(false)
    render(
      withProvider(
        <RunsScreen
          cfg={RESOLVED_CFG}
          subjects={cohortWithReconCell('done')}
          envReport={report}
          blockers={enigmaBlockers(report)}
        />,
      ),
    )

    expect(
      await screen.findByText(
        'Acquire the scientific assets to install the ENIGMA QC assets.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Rebuild assets/ })).toBeNull()
  })

  it('should submit one authoritative workflow even when a stage card is proactively blocked', async () => {
    const api = getApi()
    const planSpy = vi.spyOn(api.pipeline, 'planWorkflow')
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
          blockers={[
            { key: 'recon', reason: 'Install or configure FreeSurfer.' },
          ]}
        />,
      ),
    )
    const runAll = await screen.findByRole('button', { name: /^Run all/ })
    fireEvent.click(runAll)
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    await waitFor(() => expect(planSpy).toHaveBeenCalled())
    expect(planSpy).toHaveBeenCalledTimes(1)
    expect(planSpy.mock.calls[0]?.[0].intent).toEqual({
      kind: 'workflow',
      target: { mode: 'all' },
    })
  })

  it('should disable a downstream stage Run until its upstream step finishes', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
        />,
      ),
    )
    const featuresRun = await screen.findByRole('button', {
      name: 'Run FreeSurfer feature extraction',
    })
    expect((featuresRun as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText('Finish reconstruction before feature extraction.'),
    ).toBeTruthy()
    expect(
      (
        screen.getByRole('button', {
          name: 'Run Reconstruction',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false)
  })

  it('should enable a downstream stage once its upstream step is done', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('done')}
        />,
      ),
    )
    const featuresRun = await screen.findByRole('button', {
      name: 'Run FreeSurfer feature extraction',
    })
    expect((featuresRun as HTMLButtonElement).disabled).toBe(false)
  })

  it('should leave dependency advancement to the authoritative workflow scheduler', async () => {
    const api = getApi()
    const planSpy = vi.spyOn(api.pipeline, 'planWorkflow')
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
        />,
      ),
    )
    const runAll = await screen.findByRole('button', { name: /^Run all/ })
    fireEvent.click(runAll)
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    await waitFor(() => expect(planSpy).toHaveBeenCalled())
    expect(planSpy).toHaveBeenCalledTimes(1)
    expect(planSpy.mock.calls[0]?.[0].intent.kind).toBe('workflow')
  })

  it('should project only active jobs from the durable runtime snapshot', async () => {
    const api = getApi()
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [],
        [
          makeJob({
            id: '#run1',
            runId: 'run-1',
            subjectId: 'sub-001',
            status: 'running',
          }),
          makeJob({
            id: '#blk1',
            runId: 'run-2',
            subjectId: 'sub-002',
            status: 'blocked',
            endedAt: 2,
          }),
        ],
      ),
    )
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
        />,
      ),
    )
    expect(await screen.findByText('sub-001')).toBeTruthy()
    expect(screen.queryByText('No job is in flight.')).toBeNull()
    expect(screen.queryByText('sub-002')).toBeNull()
  })

  it('should project a live job into its precise Runs stage summary', async () => {
    const api = getApi()
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [runSnapshot('run-live', 'running')],
        [
          makeJob({
            id: '#features-live',
            runId: 'run-live',
            stepKey: 'features',
            scope: 'cohort',
            subjectId: null,
            status: 'running',
          }),
        ],
      ),
    )
    const subjects = cohort(1)
    subjects[0]!.stepStates = { features: 'pending', age: 'done' }

    render(withProvider(<RunsScreen subjects={subjects} />))

    expect(
      await screen.findByTitle(
        '1 subject is running in FreeSurfer feature extraction.',
      ),
    ).toHaveTextContent('1 running')
    // A cohort stage done for every subject states it once, on its status
    // line, with no count line.
    expect(
      screen.getByTitle('One cohort job: Age metadata integration is done.'),
    ).toHaveTextContent('Done for all 1 subjects')
    expect(
      stageCard('Age metadata integration').querySelector(
        '[data-stage-counts]',
      ),
    ).toBeNull()
  })

  it('should project a cohort job across analysis scope, not selected scope', async () => {
    const api = getApi()
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [
          runSnapshot('run-enigma', 'running', {
            analysisSubjectIds: ['sub-001', 'sub-002'],
            selectedSubjectIds: ['sub-001'],
          }),
        ],
        [
          makeJob({
            id: '#enigma-live',
            runId: 'run-enigma',
            stepKey: 'enigma',
            scope: 'cohort',
            subjectId: null,
            status: 'running',
          }),
        ],
      ),
    )
    const subjects = cohort(2)
    for (const subject of subjects) subject.stepStates = { enigma: 'pending' }

    render(
      withProvider(<RunsScreen subjects={subjects} selection={['sub-001']} />),
    )

    expect(
      await screen.findByTitle('2 subjects are running in ENIGMA QC.'),
    ).toHaveTextContent('2 running')
  })

  it('should show "K of N selected" when a partial selection is supplied', async () => {
    render(
      withProvider(
        <RunsScreen
          subjects={cohort(5)}
          selection={['sub-001', 'sub-002', 'sub-003']}
        />,
      ),
    )
    expect(await screen.findByText('3 of 5 selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Run 3 selected/ })).toBeTruthy()
    // The dock hides its run controls on Runs, so the Target chip carries the
    // clear control itself.
    expect(
      screen.getByRole('button', { name: 'Clear selected subjects' }),
    ).toBeEnabled()
  })

  it('should show "All N subjects" when no selection is supplied', async () => {
    render(withProvider(<RunsScreen subjects={cohort(5)} />))
    expect(await screen.findByText('All 5 subjects')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Run all 5/ })).toBeTruthy()
  })

  it('should use only authoritative eligible rows and keep unknown roles eligible', async () => {
    const subjects = cohort(3)
    subjects[0] = {
      ...subjects[0]!,
      cohort: 'UNKNOWN',
      cohortRole: 'ambiguous',
      analysisEligible: true,
    }
    subjects[1] = {
      ...subjects[1]!,
      qc: 'fail',
      analysisEligible: false,
      unavailableReason:
        'Exclude this subject from analysis because its QC verdict is Fail.',
    }
    subjects[2] = {
      ...subjects[2]!,
      analysisEligible: false,
      unavailableReason: "Provide this subject's T1 input.",
    }
    render(
      withProvider(
        <RunsScreen
          subjects={subjects}
          selection={['sub-001', 'sub-002', 'sub-003', 'not-found']}
        />,
      ),
    )

    expect(await screen.findByText('1 of 1 selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run 1 selected' })).toBeTruthy()
  })

  it('should explain and disable an all-QC-Fail cohort precisely', async () => {
    const subjects = cohort(2).map((subject) => ({
      ...subject,
      qc: 'fail' as const,
      analysisEligible: false,
      unavailableReason:
        'Exclude this subject from analysis because its QC verdict is Fail.',
    }))
    render(withProvider(<RunsScreen subjects={subjects} />))

    expect(
      await screen.findAllByText(
        'Change at least one QC Fail verdict before running.',
      ),
    ).not.toHaveLength(0)
    expect(screen.getByRole('button', { name: /^Run all/ })).toBeDisabled()
  })

  it('should preserve acknowledgment for eligible Defer and unreviewed rows', async () => {
    const subjects = cohort(2)
    subjects[0] = { ...subjects[0]!, qc: 'defer' }
    subjects[1] = { ...subjects[1]!, qc: null }
    render(withProvider(<RunsScreen subjects={subjects} />))

    fireEvent.click(await screen.findByRole('button', { name: 'Run all 2' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    const acknowledgement = within(dialog).getByRole('checkbox', {
      name: /Include Defer and unreviewed subjects/,
    })
    const submit = within(dialog).getByRole('button', {
      name: 'Review plan',
    })
    expect(submit).toBeDisabled()
    // The disabled Review plan is explained, with the rows the box adds.
    expect(dialog).toHaveTextContent(
      '1 Defer and 1 unreviewed subjects are in the analysis cohort. Check the box to continue.',
    )
    expect(submit).toHaveAttribute('title', 'Check the box above to continue.')
    fireEvent.click(acknowledgement)
    expect(submit).toBeEnabled()
    expect(submit).not.toHaveAttribute('title')
  })

  it('should require confirmation before canceling an active zero-job run', async () => {
    const api = getApi()
    const bootstrap = vi
      .spyOn(api.runtime, 'bootstrap')
      .mockResolvedValue(
        runtimeSnapshot([runSnapshot('run-active', 'running')]),
      )
    render(withProvider(<RunsScreen subjects={cohort(1)} />))
    await waitFor(() => expect(bootstrap).toHaveBeenCalled())
    await screen.findByText('A run is active; its jobs have not appeared yet.')
    const cancelBtn = screen.getByRole('button', { name: 'Cancel all' })
    if (!cancelBtn) throw new Error('Render a cancel button.')
    expect(cancelBtn).toBeEnabled()
    fireEvent.click(cancelBtn)
    expect(
      screen.getByRole('dialog', {
        name: 'Confirm cancellation of active runs',
      }),
    ).toBeInTheDocument()
  })

  it('should keep cancellation disabled when no durable run is active', async () => {
    render(withProvider(<RunsScreen subjects={cohort(1)} />))
    const cancelBtn = (await screen.findByText('Cancel all')).closest('button')
    expect(cancelBtn).toBeDisabled()
  })

  it('should expose a refresh control wired to the refresh prop', async () => {
    const refresh = vi.fn()
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={[]}
          refresh={refresh}
        />,
      ),
    )
    const btn = await screen.findByRole('button', {
      name: 'Refresh cohort and run state',
    })
    fireEvent.click(btn)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('should show a "Last updated" freshness stamp once data is settled', async () => {
    render(
      withProvider(<RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={[]} />),
    )
    expect(await screen.findByText(/^Last updated /)).toBeTruthy()
  })

  it('should label an auxiliary stage in plain language, not jargon', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('done')}
        />,
      ),
    )
    expect(
      (await screen.findAllByText('Progress for this stage shows in Results.'))
        .length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText(/advances no status column/)).toBeNull()
    expect(
      screen.queryByText(/Subjects matrix column|detector-backed/),
    ).toBeNull()
  })

  it('states a stage failure tag as readable text, never the raw tag', async () => {
    const { container } = render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('failed', 'oom_killed')}
        />,
      ),
    )
    expect(await screen.findByText('Out of memory.')).toBeTruthy()
    expect(container.textContent).not.toContain('oom_killed')
    expect(container.querySelector('[title*="oom_killed"]')).toBeNull()
  })

  it('states each failure reason as Logs does and once per displayed text', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithFailedRecon([
            'persistence_error',
            '-'.repeat(58),
            'oom_killed',
            'out_of_memory',
            'mri_surf2surf ended with exit code 255',
            'persistence_error',
          ])}
        />,
      ),
    )
    // A code reads as its sentence, two codes that read alike show once, a
    // separator line is no reason, and prose keeps its underscores.
    const stated =
      "Supraspina could not persist this job's state. Out of memory. " +
      'mri_surf2surf ended with exit code 255.'
    // Three reasons fit the line, so it counts none and needs no tooltip.
    expect(await screen.findByText(stated)).not.toHaveAttribute('title')
    expect(screen.getByText('6 failed').getAttribute('title')).toBe(
      `6 subjects failed in Reconstruction. ${stated}`,
    )
  })

  it.each([
    [4, '1 more reason applies.'],
    [5, '2 more reasons apply.'],
  ])(
    'states the first three of %i stage failure reasons and lists them all in the tooltip',
    async (count, more) => {
      // With many per-subject reasons the failure line counts the rest rather
      // than wrap into a paragraph, and its tooltip lists them.
      const reasons = [
        'mri_surf2surf ended with exit code 255.',
        'recon-all ended with exit code 1 in the Talairach step.',
        'The T1 image has no readable header.',
        'Out of memory.',
        'Out of disk space.',
      ].slice(0, count)
      render(
        withProvider(
          <RunsScreen
            cfg={DEFAULT_PROJECT_CONFIG}
            subjects={cohortWithFailedRecon(reasons)}
          />,
        ),
      )

      const line = await screen.findByText(
        `${reasons.slice(0, 3).join(' ')} ${more}`,
      )
      expect(line).toHaveAttribute('title', reasons.join(' '))
      expect(screen.getByText(`${count} failed`).getAttribute('title')).toBe(
        `${count} subjects failed in Reconstruction. ${reasons.join(' ')}`,
      )
    },
  )

  it('states what the newest finished ENIGMA QC job computed and reused', async () => {
    const api = getApi()
    const runs = [runSnapshot('run-73c7e1979332', 'done')]
    const reuse = (computed: string[], endedAt: number): Job =>
      makeJob({
        id: `#enigma-${endedAt}`,
        runId: 'run-73c7e1979332',
        stepKey: 'enigma',
        status: 'done',
        startedAt: endedAt - 10,
        endedAt,
        unitReuse: {
          computedSubjectIds: computed,
          reusedSubjectIds: ['sub-001', 'sub-002'],
          sourceRunIds: ['run-8407b948c62b'],
        },
      })
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(runs, [
        reuse(['sub-003'], 2_000),
        reuse(['sub-003', 'sub-004'], 1_000),
      ]),
    )
    render(
      withProvider(
        <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={cohort(3)} />,
      ),
    )

    const line = await screen.findByTestId('stage-unit-reuse')
    expect(stageCard('ENIGMA QC')).toContainElement(line)
    expect(line).toHaveTextContent(
      'Last completed run: Computed 1 subject and reused the verified output of 2 subjects from run-8407b948c62b.',
    )
    expect(
      within(stageCard('Reconstruction')).queryByTestId('stage-unit-reuse'),
    ).not.toBeInTheDocument()
  })

  it('names the subjects whose Reconstruction reran, with the reason in the tooltip', async () => {
    // The rerun must show outside the receipt JSON.
    const detail =
      'mris_fix_topology crashed in the genetic surface topology fix (-ga). ' +
      'The first attempt exited with code 134.'
    const subjects = Array.from({ length: 8 }, (_, index) => {
      const [subject] = cohortWithReconCell('done')
      if (!subject) throw new Error('Build the rerun fixture.')
      const cells = subject.cells.map((cell) => ({ ...cell }))
      if (index < 7 && cells[0]) {
        cells[0].rerun = { fact: 'Reran with -no-fix-with-ga', detail }
      }
      return { ...subject, id: `sub-1${40 + index}`, cells }
    })
    render(
      withProvider(
        <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={subjects} />,
      ),
    )

    const line = await screen.findByText(
      'Reran with -no-fix-with-ga: sub-140, sub-141, sub-142, ' +
        'sub-143, sub-144, sub-145, and 1 more.',
    )
    expect(stageCard('Reconstruction')).toContainElement(line)
    expect(line).toHaveAttribute('title', detail)
    expect(
      within(stageCard('ENIGMA QC')).queryByTestId('stage-rerun'),
    ).not.toBeInTheDocument()
  })

  it('shows no failure reason when the only one recorded is a separator', async () => {
    const { container } = render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('failed', '-'.repeat(58))}
        />,
      ),
    )
    const failedCount = await screen.findByText('1 failed')
    expect(failedCount.getAttribute('title')).toBe(
      '1 subject failed in Reconstruction.',
    )
    expect(container.textContent).not.toContain('---')
  })

  it('counts a dependency-blocked stage as blocked rather than failed', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('blocked')}
        />,
      ),
    )
    const blocked = await screen.findByText('1 blocked')
    expect(blocked.getAttribute('title')).toContain(
      '1 subject is blocked in Reconstruction.',
    )
    expect(
      stageCard('Reconstruction').querySelector('[data-stage-counts]')
        ?.textContent,
    ).toBe('1 blocked of 1 subject')
    expect(screen.queryByText(/^\d+ failed$/)).toBeNull()
  })

  it.each([
    [
      'cancelled',
      "Canceled at the operator's request.",
      '1 canceled',
      '1 subject was canceled in Reconstruction.',
    ],
    [
      'interrupted',
      'The job was still queued when Supraspina restarted.',
      '1 interrupted',
      '1 subject was interrupted in Reconstruction.',
    ],
    [
      'stale',
      null,
      '1 status unknown',
      '1 subject has an unknown status in Reconstruction.',
    ],
  ] as const)(
    'counts the %s state apart from failed, with no failure line',
    async (state, reason, count, title) => {
      // After Cancel all the canceled subject must not count as failed.
      render(
        withProvider(
          <RunsScreen
            cfg={DEFAULT_PROJECT_CONFIG}
            subjects={cohortWithReconCell(state, reason)}
          />,
        ),
      )

      expect(await screen.findByText(count)).toHaveAttribute('title', title)
      expect(
        stageCard('Reconstruction').querySelector('[data-stage-counts]')
          ?.textContent,
      ).toBe(`${count} of 1 subject`)
      expect(screen.queryByText(/^\d+ failed$/)).toBeNull()
      if (reason) expect(screen.queryByText(reason)).toBeNull()
    },
  )

  it('states a canceled cohort job as canceled, not failed', async () => {
    const subjects = cohort(3)
    for (const subject of subjects) {
      subject.stepStates = { ...subject.stepStates, enigma: 'cancelled' }
    }
    render(withProvider(<RunsScreen cfg={RESOLVED_CFG} subjects={subjects} />))

    expect(await screen.findByText('Canceled')).toHaveAttribute(
      'title',
      'One cohort job: ENIGMA QC was canceled.',
    )
    expect(screen.getByText('3 canceled')).toHaveAttribute(
      'title',
      '3 subjects were canceled in ENIGMA QC.',
    )
    expect(screen.queryByText('Failed')).toBeNull()
    expect(screen.queryByText('3 failed')).toBeNull()
  })

  it('states each stage count as a fact and leaves out zero counts', async () => {
    // Count tooltips state facts, not orders such as "Review 6 subjects marked
    // failed in Reconstruction.", and a zero count has none.
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithFailedRecon([null, null, null, null, null, null])}
        />,
      ),
    )

    expect(await screen.findByText('6 failed')).toHaveAttribute(
      'title',
      '6 subjects failed in Reconstruction.',
    )
    expect(
      stageCard('Reconstruction').querySelector('[data-stage-counts]')
        ?.textContent,
    ).toBe('6 failed of 6 subjects')
    expect(screen.queryByText(/^0 /)).toBeNull()
    expect(screen.queryByTitle(/^0 subjects /)).toBeNull()
    expect(screen.queryByTitle(/^Review /)).toBeNull()
  })

  it('should give a stage failed count a count-aware tooltip', async () => {
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('failed', 'oom_killed')}
        />,
      ),
    )
    const failedCount = await screen.findByText('1 failed')
    expect(failedCount.getAttribute('title')).toBe(
      '1 subject failed in Reconstruction. Out of memory.',
    )
  })

  it('prefers a precise stage state over a later shared-column producer', async () => {
    const subjects = cohort(1)
    const subject = subjects[0]
    const featureColumn = MATRIX_STEPS.findIndex((step) => step.key === 'feat')
    if (!subject || featureColumn < 0) {
      throw new Error('Provide the feature-column fixture.')
    }
    subject.cells[featureColumn] = {
      ...subject.cells[featureColumn]!,
      st: 'pending',
    }
    subject.stepStates = { features: 'done', age: 'pending' }

    render(withProvider(<RunsScreen subjects={subjects} />))

    expect(
      await screen.findByTitle(
        'One cohort job: FreeSurfer feature extraction is done.',
      ),
    ).toHaveTextContent('Done for all 1 subjects')
    // No title or line counts Age metadata integration as done.
    expect(
      screen.queryByTitle(/ done in Age metadata integration\./),
    ).toBeNull()
    expect(
      screen.queryByTitle('One cohort job: Age metadata integration is done.'),
    ).toBeNull()
    expect(stageCard('Age metadata integration')).not.toHaveTextContent(
      /Done for all|\d+ done/,
    )
  })

  it('does not borrow ambiguous shared-column state without a stage entry', async () => {
    const subjects = cohort(2)
    const featureColumn = MATRIX_STEPS.findIndex((step) => step.key === 'feat')
    if (featureColumn < 0) {
      throw new Error('Provide the feature-column fixture.')
    }
    subjects[0]!.cells[featureColumn] = {
      ...subjects[0]!.cells[featureColumn]!,
      st: 'running',
    }
    subjects[1]!.cells[featureColumn] = {
      ...subjects[1]!.cells[featureColumn]!,
      st: 'failed',
      err: 'feature_failure',
    }

    render(withProvider(<RunsScreen subjects={subjects} />))

    await screen.findByRole('button', {
      name: 'Run FreeSurfer feature extraction',
    })
    // Every count of both stages is zero, so none has a tooltip.
    expect(
      screen.queryByTitle(/ in FreeSurfer feature extraction\.$/),
    ).toBeNull()
    expect(screen.queryByTitle(/ in Age metadata integration\.$/)).toBeNull()
  })

  it('keeps subject stages selected and cohort stages cohort-wide', async () => {
    const subjects = cohort(2)
    subjects[0]!.stepStates = { recon: 'done', features: 'done' }
    subjects[1]!.stepStates = { recon: 'failed', features: 'done' }

    render(
      withProvider(<RunsScreen subjects={subjects} selection={['sub-001']} />),
    )

    expect(
      await screen.findByTitle('1 subject is done in Reconstruction.'),
    ).toHaveTextContent('1 done')
    expect(screen.queryByTitle(/ failed in Reconstruction\./)).toBeNull()
    expect(
      screen.getByTitle(
        'One cohort job: FreeSurfer feature extraction is done.',
      ),
    ).toHaveTextContent('Done for all 2 subjects')
  })

  it('expands stage guidance and routes its log action through shared state', async () => {
    render(
      withProvider(
        <>
          <RunsScreen subjects={cohortWithReconCell('pending')} />
          <RouteProbe />
        </>,
      ),
    )

    const disclosure = await screen.findByRole('button', {
      name: /Reconstruction.*subject/i,
    })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('stage-recon')).toBeInTheDocument()
    fireEvent.click(disclosure)
    expect(document.getElementById('stage-recon')).toBeNull()

    const viewLog = screen.getByRole('button', {
      name: 'View log for Reconstruction',
    })
    expect(viewLog).toHaveAttribute(
      'title',
      'Opens Logs on its default run; Reconstruction has no job in any restored run.',
    )
    // A hard-coded article would read "a ENIGMA QC job"; the title reads for
    // any stage name.
    const viewLogs = screen.getAllByRole('button', { name: /^View log for / })
    const names = viewLogs.map((button) =>
      (button.getAttribute('aria-label') ?? '').replace(/^View log for /, ''),
    )
    expect(names).toEqual(
      expect.arrayContaining(['ENIGMA QC', 'Age metadata integration']),
    )
    viewLogs.forEach((button, index) =>
      expect([
        `Opens Logs on its default run; ${names[index]} has no job in any restored run.`,
        `Opens Logs on the newest run in which ${names[index]} has a job.`,
      ]).toContain(button.getAttribute('title')),
    )
    fireEvent.click(viewLog)
    expect(screen.getByTestId('route-probe')).toHaveTextContent('logs:null')
    // With no job of the stage, no run is handed over.
    expect(screen.getByTestId('route-probe')).toHaveAttribute(
      'data-logs-focus',
      '',
    )
  })

  it('states the stage guidance once when a stage card expands', async () => {
    // The stage goal and the guidance say the same thing in other words, so the
    // expanded card states one of them.
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Histogram and outlier review.*Cohort/i,
      }),
    )
    const detail = document.getElementById('stage-outliers')
    if (!detail) throw new Error('Expand the outlier review card.')
    const outliers = PIPELINE_STEPS.find((step) => step.key === 'outliers')
    if (!outliers) throw new Error('Find the outlier review stage.')
    expect(within(detail).getAllByText(STEP_HELP.outliers)).toHaveLength(1)
    expect(within(detail).queryByText(outliers.goal)).toBeNull()
  })

  it("opens Logs on the stage's newest run from its View log", async () => {
    // View log hands over the run of the stage's newest job, as the Dashboard's
    // Recent runs does, rather than open Logs on its default run with focus
    // left on the page body.
    vi.spyOn(getApi().runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [
          runSnapshot('run-old', 'failed', { startedAt: 1_000 }),
          runSnapshot('run-new', 'done', { startedAt: 2_000 }),
          // The newest run ran another stage only.
          runSnapshot('run-other', 'done', { startedAt: 3_000 }),
        ],
        [
          makeJob({
            id: '#recon-old',
            runId: 'run-old',
            subjectId: 'sub-001',
            startedAt: 1_000,
            status: 'failed',
          }),
          makeJob({
            id: '#recon-new',
            runId: 'run-new',
            subjectId: 'sub-001',
            startedAt: 2_000,
            status: 'done',
          }),
          makeJob({
            id: '#features',
            runId: 'run-other',
            stepKey: 'features',
            startedAt: 3_000,
            status: 'done',
          }),
        ],
      ),
    )
    render(
      withProvider(
        <>
          <RunsScreen subjects={cohortWithReconCell('done')} />
          <RouteProbe />
        </>,
      ),
    )

    const viewLog = await screen.findByRole('button', {
      name: 'View log for Reconstruction',
    })
    // The jobs arrive with the runtime restore.
    await screen.findByRole('button', { name: 'Run all 1' })
    await waitFor(() =>
      expect(screen.queryByText('Restoring run history...')).toBeNull(),
    )
    // The title states what opens, and the stage goes with the run, so Logs
    // selects that run's newest Reconstruction job.
    expect(viewLog).toHaveAttribute(
      'title',
      'Opens Logs on the newest run in which Reconstruction has a job.',
    )
    fireEvent.click(viewLog)
    expect(screen.getByTestId('route-probe')).toHaveTextContent('logs:null')
    expect(screen.getByTestId('route-probe')).toHaveAttribute(
      'data-logs-focus',
      'run-new',
    )
    expect(screen.getByTestId('route-probe')).toHaveAttribute(
      'data-logs-focus-stage',
      'recon',
    )
  })

  it('requires and forwards the low-memory workflow acknowledgment', async () => {
    const planSpy = vi.spyOn(getApi().pipeline, 'planWorkflow')
    render(
      withProvider(
        <RunsScreen subjects={cohort(1)} envReport={LOW_MEMORY_REPORT} />,
      ),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Run all 1' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    const acknowledgement = within(dialog).getByRole('checkbox', {
      name: "Continue although available host memory (1.0 GB) is below this project's 10 GB memory advisory threshold.",
    })
    const submit = within(dialog).getByRole('button', {
      name: 'Review plan',
    })
    expect(submit).toBeDisabled()
    expect(dialog).toHaveTextContent(
      'Review plan needs this acknowledgement while available host memory is below 10 GB.',
    )
    fireEvent.click(acknowledgement)
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(planSpy).toHaveBeenCalledOnce())
    expect(
      planSpy.mock.calls[0]?.[0].acknowledgements.acknowledgeMemoryAdvisory,
    ).toBe(true)
  })

  it('never offers to adopt unknown-provenance Recon output', async () => {
    const api = getApi()
    vi.spyOn(api.results, 'list').mockResolvedValue({
      items: [unknownProvenanceReconArtifact()],
      nextCursor: null,
      truncated: false,
    })
    render(withProvider(<RunsScreen subjects={cohort(2)} />))

    fireEvent.click(await screen.findByRole('button', { name: 'Run all 2' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })

    expect(within(dialog).queryByText(/adopt/i)).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/legacy/i)).not.toBeInTheDocument()
  })

  it('states a workflow launch by the names of the enabled stages', async () => {
    const defaceOn = {
      ...DEFAULT_PROJECT_CONFIG,
      steps: {
        ...DEFAULT_PROJECT_CONFIG.steps,
        deface: { ...DEFAULT_PROJECT_CONFIG.steps.deface, enabled: true },
      },
    }
    const { rerender } = render(
      withProvider(
        <RunsScreen cfg={DEFAULT_PROJECT_CONFIG} subjects={cohort(2)} />,
      ),
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Run all 2' }))
    const dialog = screen.getByRole('dialog', {
      name: 'Review the run plan?',
    })
    expect(dialog).toHaveTextContent(
      'Brain FOV preparation and Reconstruction run for all 2 subjects in the analysis cohort; cohort-wide stages run once after them.',
    )
    // The dialog's title is "Review the run plan?"; its message names no
    // other review and no stage that is off.
    expect(dialog.textContent?.replace('Review the run plan?', '')).not.toMatch(
      /Optional defacing|Review the/,
    )

    rerender(withProvider(<RunsScreen cfg={defaceOn} subjects={cohort(2)} />))
    expect(
      screen.getByRole('dialog', { name: 'Review the run plan?' }),
    ).toHaveTextContent(
      'Brain FOV preparation, Optional defacing, and Reconstruction run for all 2 subjects',
    )
  })

  it('requires QC acknowledgment for a cohort stage and names its rows', async () => {
    const planSpy = vi.spyOn(getApi().pipeline, 'planWorkflow')
    const deferred = cohortWithReconCell('done')
    deferred[0] = { ...deferred[0]!, qc: 'defer' }
    render(withProvider(<RunsScreen subjects={deferred} />))

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Run ENIGMA QC',
      }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm the ENIGMA QC launch',
    })
    expect(dialog).toHaveTextContent(
      'ENIGMA QC runs once over the full analysis cohort.',
    )
    const submit = within(dialog).getByRole('button', { name: 'Review plan' })
    expect(submit).toBeDisabled()
    expect(dialog).toHaveTextContent(
      '1 Defer subject is in the analysis cohort. Check the box to continue.',
    )
    fireEvent.click(
      within(dialog).getByRole('checkbox', {
        name: /Include Defer and unreviewed subjects/,
      }),
    )
    fireEvent.click(submit)

    await waitFor(() => expect(planSpy).toHaveBeenCalledOnce())
    expect(planSpy.mock.calls[0]?.[0]).toMatchObject({
      intent: { kind: 'stage', stepKey: 'enigma' },
      acknowledgements: { includeDeferredAndUnreviewedQc: true },
    })
  })

  it('launches a per-subject stage without the Defer acknowledgement', async () => {
    // A per-subject stage's plan does not read QC verdicts, so Brain FOV for
    // new, never-reviewed subjects does not ask about the cohort's Defer and
    // unreviewed rows. The planner still needs the acknowledgement, so the
    // launch gives it.
    const planSpy = vi.spyOn(getApi().pipeline, 'planWorkflow')
    const deferred = cohortWithReconCell('pending')
    deferred[0] = { ...deferred[0]!, qc: null }
    render(withProvider(<RunsScreen subjects={deferred} />))

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Run Reconstruction',
      }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm the Reconstruction launch',
    })
    expect(dialog).toHaveTextContent(
      'Reconstruction runs for the 1 subject in the analysis cohort.',
    )
    expect(
      within(dialog).queryByRole('checkbox', {
        name: /Include Defer and unreviewed subjects/,
      }),
    ).toBeNull()
    expect(dialog).not.toHaveTextContent(/unreviewed subject/)
    const submit = within(dialog).getByRole('button', { name: 'Review plan' })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(planSpy).toHaveBeenCalledOnce())
    expect(planSpy.mock.calls[0]?.[0]).toMatchObject({
      intent: { kind: 'stage', stepKey: 'recon' },
      acknowledgements: { includeDeferredAndUnreviewedQc: true },
    })
  })

  it('requires and forwards the low-memory acknowledgment for a stage', async () => {
    const planSpy = vi.spyOn(getApi().pipeline, 'planWorkflow')
    render(
      withProvider(
        <RunsScreen
          subjects={cohortWithReconCell('pending')}
          envReport={LOW_MEMORY_REPORT}
        />,
      ),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm the Reconstruction launch',
    })
    const acknowledgement = within(dialog).getByRole('checkbox', {
      name: "Continue although available host memory (1.0 GB) is below this project's 10 GB memory advisory threshold.",
    })
    const submit = within(dialog).getByRole('button', { name: 'Review plan' })
    expect(submit).toBeDisabled()
    expect(dialog).toHaveTextContent(
      'Review plan needs this acknowledgement while available host memory is below 10 GB.',
    )
    fireEvent.click(acknowledgement)
    expect(submit).toBeEnabled()
    fireEvent.click(submit)

    await waitFor(() => expect(planSpy).toHaveBeenCalledOnce())
    expect(planSpy.mock.calls[0]?.[0]).toMatchObject({
      intent: { kind: 'stage', stepKey: 'recon' },
      acknowledgements: { acknowledgeMemoryAdvisory: true },
    })
  })

  it('retries canceled jobs only after explicit confirmation', async () => {
    const api = getApi()
    const retrySpy = vi.spyOn(api.pipeline, 'retryWorkflow')
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-cancelled', 'cancelled')]),
    )
    render(
      withProvider(
        <>
          <RunsScreen subjects={cohort(1)} />
          <HostProbe />
        </>,
      ),
    )

    const retry = await screen.findByRole('button', {
      name: 'Retry canceled...',
    })
    await waitFor(() => expect(retry).toBeEnabled())
    await screen.findByText('ready', { selector: '[data-testid="host-probe"]' })
    fireEvent.click(retry)
    const retryDialog = screen.getByRole('dialog', {
      name: 'Confirm retrying canceled work',
    })
    expect(within(retryDialog).queryByText(/run-cancelled/)).toBeNull()
    expect(
      within(retryDialog).getByText(
        `Only canceled outstanding jobs from the canceled run started ${runTimestampLabel(1)} (1 subject) are retried. Successful jobs stay skipped.`,
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stay canceled' }))
    expect(
      screen.queryByRole('dialog', {
        name: 'Confirm retrying canceled work',
      }),
    ).toBeNull()

    fireEvent.click(retry)
    fireEvent.click(screen.getByRole('button', { name: 'Retry canceled jobs' }))
    await waitFor(() => expect(retrySpy).toHaveBeenCalledOnce())
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-cancelled',
      includeCancelled: true,
      cleanIncomplete: false,
    })
  })

  it('states the retry the other controls wait for while it plans', async () => {
    const api = getApi()
    let release!: (value: WorkflowResult) => void
    vi.spyOn(api.pipeline, 'retryWorkflow').mockImplementation(
      () =>
        new Promise<WorkflowResult>((resolve) => {
          release = resolve
        }),
    )
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-cancelled', 'cancelled')]),
    )
    render(
      withProvider(
        <>
          <RunsScreen subjects={cohort(1)} />
          <HostProbe />
        </>,
      ),
    )
    const retry = await screen.findByRole('button', {
      name: 'Retry canceled...',
    })
    await waitFor(() => expect(retry).toBeEnabled())
    await screen.findByText('ready', { selector: '[data-testid="host-probe"]' })
    fireEvent.click(retry)
    fireEvent.click(screen.getByRole('button', { name: 'Retry canceled jobs' }))

    // The held cards state what Supraspina is doing, not an order to wait.
    expect(
      (await screen.findAllByText('Supraspina is planning the retry.')).length,
    ).toBeGreaterThan(0)
    expect(screen.queryByText(/Wait while/)).toBeNull()
    expect(screen.getByRole('button', { name: /^Run all/ })).toBeDisabled()

    await act(async () => {
      release(fulfilledOutcome('noop', 'No work is scheduled.'))
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        screen.queryByText('Supraspina is planning the retry.'),
      ).toBeNull(),
    )
  })

  it('says in the retry confirmation that a live plan opens read-only while Allow live runs is off', async () => {
    vi.spyOn(getApi().runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-cancelled', 'cancelled')]),
    )
    const live = structuredClone(RESOLVED_CFG)
    live.runtime.dryRun = false
    render(withProvider(<RunsScreen cfg={live} subjects={cohort(1)} />))

    const retry = await screen.findByRole('button', {
      name: 'Retry canceled...',
    })
    await waitFor(() => expect(retry).toBeEnabled())
    fireEvent.click(retry)
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm retrying canceled work',
    })
    // The same notice and next step as the Run all and Resume confirmations.
    expect(dialog).toHaveTextContent(
      'Allow live runs is off for this session. Turn it on, then save the project to authorize and run live.',
    )
    expect(dialog).toHaveTextContent(
      'If anything would run, the plan opens read-only, because Allow live runs is off.',
    )
    expect(
      within(dialog).getByRole('button', { name: 'Allow live runs' }),
    ).toBeEnabled()
    expect(
      within(dialog).getByRole('button', { name: 'Retry canceled jobs' }),
    ).toBeEnabled()
  })

  it('cleans incomplete work only with Allow live runs and confirmation', async () => {
    const api = getApi()
    const retrySpy = vi.spyOn(api.pipeline, 'retryWorkflow')
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-incomplete', 'failed')]),
    )
    render(
      withProvider(<RunsScreen subjects={cohort(1)} />, {
        safeExecution: true,
      }),
    )

    const clean = await screen.findByRole('button', {
      name: 'Clean up and retry...',
    })
    await waitFor(() => expect(clean).toBeEnabled())
    fireEvent.click(clean)
    const cleanDialog = screen.getByRole('dialog', {
      name: 'Confirm deleting incomplete outputs before retrying',
    })
    expect(within(cleanDialog).queryByText(/run-incomplete/)).toBeNull()
    expect(
      within(cleanDialog).getByText(
        `Only backend-identified incomplete outputs for the failed run started ${runTimestampLabel(1)} (1 subject) are removed, and then outstanding jobs are retried. Completed outputs are preserved. Approving the plan grants one-use cleanup authorization.`,
      ),
    ).toBeInTheDocument()
    // Allow live runs is already on, so the dialog does not ask for it.
    expect(cleanDialog).not.toHaveTextContent('Allow live runs')
    fireEvent.click(screen.getByRole('button', { name: 'Keep outputs' }))
    expect(
      screen.queryByRole('dialog', {
        name: 'Confirm deleting incomplete outputs before retrying',
      }),
    ).toBeNull()

    fireEvent.click(clean)
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete incomplete and retry' }),
    )
    await waitFor(() => expect(retrySpy).toHaveBeenCalledOnce())
    expect(retrySpy.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-incomplete',
      includeCancelled: false,
      cleanIncomplete: true,
    })
  })

  it('cancels every active durable run after confirmation', async () => {
    const api = getApi()
    const cancelSpy = vi.spyOn(api.pipeline, 'cancelRun')
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([
        runSnapshot('run-active-a', 'running'),
        runSnapshot('run-active-b', 'running'),
      ]),
    )
    render(withProvider(<RunsScreen subjects={cohort(1)} />))

    await screen.findByText(
      '2 runs are active; their jobs have not appeared yet.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }))
    expect(
      screen.getByRole('dialog', {
        name: 'Confirm cancellation of active runs',
      }),
    ).toHaveTextContent(
      'Cancel jobs requests cancellation for 2 active runs. Cancellation is complete only once each job acknowledges it.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel jobs' }))

    await waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(2))
    expect(cancelSpy.mock.calls.map((call) => call[0].runId).sort()).toEqual([
      'run-active-a',
      'run-active-b',
    ])
    expect(
      await screen.findAllByText(
        'Cancellation is requested; Supraspina waits for each active job to acknowledge it.',
      ),
    ).not.toHaveLength(0)
  })

  /** Bootstrap one running run: sub-001 finished, sub-002 still running. */
  function runningRunToCancel(): {
    publish: () => (event: RuntimeEvent) => void
  } {
    const api = getApi()
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [runSnapshot('run-1', 'running')],
        [
          makeJob({
            id: '#done',
            runId: 'run-1',
            subjectId: 'sub-001',
            status: 'done',
            endedAt: 2,
          }),
          makeJob({
            id: '#hang',
            runId: 'run-1',
            subjectId: 'sub-002',
            status: 'running',
            startedAt: Date.now(),
          }),
        ],
      ),
    )
    let listener: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      listener = cb
      return () => {}
    })
    return {
      publish: () => {
        const events = listener as ((event: RuntimeEvent) => void) | null
        if (!events) throw new Error('The runtime event listener is missing.')
        return events
      },
    }
  }

  /** Settle run-1 as canceled: the hung job acknowledged the request. */
  function settleCanceledRun(publish: (event: RuntimeEvent) => void): void {
    publish(
      jobEvent({ id: '#hang', subjectId: 'sub-002', status: 'cancelled' }, 2),
    )
    publish(runEvent(runSnapshot('run-1', 'cancelled'), 3))
  }

  const CANCELED_RUN_FACT =
    'Run run-1 was canceled: 1 job finished, 1 canceled.'

  it('states how a canceled run ended in place of the cancellation request', async () => {
    const api = getApi()
    const runtime = runningRunToCancel()
    // The sidecar answers the request only once the run has settled, so the
    // run's end arrives before the request returns.
    let answer: (() => void) | null = null
    vi.spyOn(api.pipeline, 'cancelRun').mockImplementation(
      ({ runId }) =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              runId,
              accepted: true,
              terminal: true,
              pendingJobIds: [],
              message: 'Cancellation settled.',
            })
        }),
    )
    render(
      withProvider(
        <>
          <RunsScreen subjects={cohort(2)} />
          <RouteProbe />
        </>,
      ),
    )

    const cancel = await screen.findByRole('button', { name: 'Cancel all' })
    await waitFor(() => expect(cancel).toBeEnabled())
    fireEvent.click(cancel)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel jobs' }))
    await act(async () => {
      settleCanceledRun(runtime.publish())
    })
    await act(async () => {
      ;(answer as (() => void) | null)?.()
    })

    await waitFor(() => expect(statusTexts()).toContain(CANCELED_RUN_FACT))
    expect(screen.queryByText(/Cancellation is requested/)).toBeNull()
    // Logs lists each job of the canceled run with its outcome, and opens on
    // the run the notice names.
    fireEvent.click(screen.getByRole('button', { name: 'Open Logs' }))
    expect(screen.getByTestId('route-probe').textContent).toMatch(/^logs:/)
    expect(screen.getByTestId('route-probe')).toHaveAttribute(
      'data-logs-focus',
      'run-1',
    )
  })

  it('states how a canceled run ended after the operator left Runs and came back', async () => {
    const runtime = runningRunToCancel()
    function Shell({ showRuns }: { showRuns: boolean }): ReactNode {
      return showRuns ? (
        <RunsScreen subjects={cohort(2)} />
      ) : (
        <output>elsewhere</output>
      )
    }
    const { rerender } = render(withProvider(<Shell showRuns />))
    const cancel = await screen.findByRole('button', { name: 'Cancel all' })
    await waitFor(() => expect(cancel).toBeEnabled())
    fireEvent.click(cancel)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel jobs' }))
    await waitFor(() =>
      expect(statusTexts()).toContain(
        'Cancellation is requested; Supraspina waits for each active job to acknowledge it.',
      ),
    )

    // Leave Runs while the job has not acknowledged the request yet.
    rerender(withProvider(<Shell showRuns={false} />))
    await act(async () => {
      settleCanceledRun(runtime.publish())
    })
    rerender(withProvider(<Shell showRuns />))

    await waitFor(() => expect(statusTexts()).toContain(CANCELED_RUN_FACT))
    expect(screen.queryByText(/Cancellation is requested/)).toBeNull()
  })

  it('follows a started run into its canceled outcome', async () => {
    const publish = await followStartedRun()

    // The run was canceled from outside Runs, for example from the run dock.
    await act(async () => {
      publish(
        jobEvent(
          { id: '#recon', subjectId: 'sub-001', status: 'cancelled' },
          2,
        ),
      )
      publish(runEvent(runSnapshot('run-1', 'cancelled'), 3))
    })

    await waitFor(() =>
      expect(statusTexts()).toContain(
        'Run run-1 was canceled: 1 job canceled.',
      ),
    )
    expect(screen.getByRole('button', { name: 'Open Logs' })).toBeEnabled()
    expect(screen.queryByText(/The run is queued\./)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders every active job status and stops only the chosen run', async () => {
    const api = getApi()
    const cancelSpy = vi.spyOn(api.pipeline, 'cancelRun')
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot(
        [],
        (
          ['planned', 'waiting', 'queued', 'running', 'cancelling'] as const
        ).map((status, index) =>
          makeJob({
            id: `#${status}`,
            runId: `run-${status}`,
            subjectId: index === 0 ? null : `sub-00${index}`,
            status,
            startedAt: index === 0 ? null : Date.now() - index * 1000,
            ...(index === 0 ? { plannedAt: Date.now() - 500 } : {}),
          }),
        ),
      ),
    )
    render(withProvider(<RunsScreen subjects={cohort(5)} />))

    for (const label of [
      'Planned',
      'Waiting',
      'Queued',
      'Running',
      'Canceling',
    ]) {
      expect(await screen.findByText(label)).toBeInTheDocument()
    }
    expect(screen.getAllByText('Cohort').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/\d+s|Waiting/).length).toBeGreaterThan(0)

    // Only a started job offers Stop; a queued job has nothing to stop yet.
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0]!)
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledOnce())
    expect(cancelSpy.mock.calls[0]?.[0].runId).toBe('run-running')
  })

  it('routes an undiscovered cohort to Setup recovery', async () => {
    render(
      withProvider(
        <>
          <RunsScreen subjects={[]} />
          <RouteProbe />
        </>,
      ),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open Setup wizard' }),
    )
    expect(screen.getByTestId('route-probe')).toHaveTextContent('wizard:null')
  })

  it('routes an all-failed cohort to QC recovery', async () => {
    const failed = cohort(1).map((row) => ({
      ...row,
      qc: 'fail' as const,
      analysisEligible: false,
    }))
    render(
      withProvider(
        <>
          <RunsScreen subjects={failed} />
          <RouteProbe />
        </>,
      ),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: 'Open QC review' }),
    )
    expect(screen.getByTestId('route-probe')).toHaveTextContent('qc:null')
  })

  it('updates the shared dry-run posture and execution warning', async () => {
    render(withProvider(<RunsScreen subjects={cohort(1)} />))
    const toggle = await screen.findByRole('switch', { name: 'Dry run first' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    // The switches state their default settings without a state line; each
    // tooltip says what the switch does.
    expect(screen.queryByText('Commands execute on this host.')).toBeNull()
    const rerun = screen.getByRole('switch', {
      name: 'Rerun incomplete output',
    })
    expect(rerun).toHaveAttribute('aria-checked', 'false')
    expect(rerun.closest('[title]')).toHaveAttribute(
      'title',
      'Replaces partial output from an interrupted stage instead of keeping it for inspection.',
    )
    expect(screen.queryByText('A rerun replaces partial output.')).toBeNull()
    // A setting that changes what runs states the change as a fact.
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(screen.getByText('Commands execute on this host.')).toBeTruthy()
  })

  it('surfaces a non-Error stage launch rejection without losing the stage', async () => {
    vi.spyOn(getApi().pipeline, 'planWorkflow').mockRejectedValue(
      'host rejected',
    )
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Run Reconstruction',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Retry running the stage.')
    expect(
      screen.getByRole('button', { name: 'Run Reconstruction' }),
    ).toBeEnabled()
  })

  it('titles a stage launch error as written and a bare code as its fact', async () => {
    // Humanizing free text would turn "mri_surf2surf" into "Mri surf2surf".
    vi.spyOn(getApi().pipeline, 'planWorkflow')
      .mockRejectedValueOnce(
        new Error('mri_surf2surf ended with exit code 255.'),
      )
      .mockRejectedValueOnce(new Error('oom_killed'))
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )
    const launch = async (): Promise<HTMLElement> => {
      fireEvent.click(
        await screen.findByRole('button', { name: 'Run Reconstruction' }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
      return screen.findByRole('alert')
    }

    let alert = await launch()
    expect(
      within(alert).getAllByText('mri_surf2surf ended with exit code 255.'),
    ).toHaveLength(1)
    expect(screen.queryByText(/Mri surf2surf/)).toBeNull()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Run Reconstruction' }),
      ).toBeEnabled(),
    )
    alert = await launch()
    await waitFor(() => expect(alert).toHaveTextContent('Out of memory'))
    // A code keeps its recorded form below the fact.
    expect(within(alert).getByText('oom_killed')).toBeInTheDocument()
  })

  it('offers Review again for PLAN_STALE and repeats the same stage from a fresh plan', async () => {
    const api = getApi()
    const plan = vi.spyOn(api.pipeline, 'planWorkflow')
    const run = vi
      .spyOn(api.pipeline, 'runWorkflow')
      .mockRejectedValueOnce(new PlanStaleError())
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Run Reconstruction',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    const reviewAgain = await screen.findByRole('button', {
      name: 'Review again',
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Review the workflow plan again because the approved plan changed.',
    )
    expect(plan).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)

    fireEvent.click(reviewAgain)

    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(plan.mock.calls[1]?.[0].intent).toEqual({
      kind: 'stage',
      stepKey: 'recon',
      target: { mode: 'all' },
    })
    expect(
      screen.queryByRole('button', { name: 'Review again' }),
    ).not.toBeInTheDocument()
    expect(await screen.findByRole('status')).toHaveTextContent(
      /Reconstruction: dry run only; planned \d+ commands? and executed nothing\./,
    )
  })

  it('offers Review again for PLAN_STALE and freshly re-previews the same Runs resume', async () => {
    const api = getApi()
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-failed', 'failed')]),
    )
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
          throw new PlanStaleError()
        }
        return originalResume(request)
      })
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('failed', 'topology_failure')}
        />,
      ),
    )

    await screen.findByText(CLEANUP_SAFE_EXECUTION_OFF)
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review again' }))

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

  it.each([
    [
      'blocked',
      'Review the current input before reconstructing.',
      'Reconstruction: review the current input before reconstructing.',
    ],
    [
      'noop',
      'Continue because no reconstruction work is required.',
      'Reconstruction: continue because no reconstruction work is required.',
    ],
  ] as const)(
    'renders a fulfilled %s summary as a status notice rather than an error',
    async (disposition, message, line) => {
      vi.spyOn(getApi().pipeline, 'planWorkflow').mockResolvedValueOnce(
        fulfilledOutcome(disposition, message),
      )
      render(
        withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
      )

      fireEvent.click(
        await screen.findByRole('button', {
          name: 'Run Reconstruction',
        }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

      // The planning indicator is a status too, so wait for the notices: the
      // page line announces the outcome with the stage name and the card
      // repeats it silently beside the stage.
      await waitFor(() => expect(screen.getByText(line)).toBeInTheDocument())
      expect(screen.getByText(message)).toBeInTheDocument()
      expect(
        screen
          .getAllByRole('status')
          .filter((node) => node.textContent?.includes(line)),
      ).toHaveLength(1)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )

  it('leaves no failure banner after the plan review is canceled', async () => {
    const api = getApi()
    const runSpy = vi.spyOn(api.pipeline, 'runWorkflow')
    workflowReview.approve = false
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    await screen.findAllByText('Planning Reconstruction...')
    await waitFor(() =>
      expect(
        screen.queryByText('Planning Reconstruction...'),
      ).not.toBeInTheDocument(),
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Stop because|review canceled/i),
    ).not.toBeInTheDocument()
    expect(runSpy).not.toHaveBeenCalled()
  })

  it.each([
    [
      'noop',
      'No work is scheduled: all 82 nodes are current.',
      'No work is scheduled: all 82 jobs are current.',
      'info',
    ],
    [
      'blocked',
      'Resolve 1 blocked node. Brain FOV preparation failed, so this step did not run.',
      'No work is scheduled: 1 job is blocked. Brain FOV preparation failed, so this step did not run.',
      'warning',
    ],
  ] as const)(
    'renders a %s stage outcome in the %s tone on its card',
    async (disposition, summary, message, tone) => {
      vi.spyOn(getApi().pipeline, 'planWorkflow').mockResolvedValueOnce(
        fulfilledOutcome(disposition, summary),
      )
      render(
        withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
      )

      fireEvent.click(
        await screen.findByRole('button', { name: 'Run Reconstruction' }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

      const cardOutcome = await waitFor(() => {
        const node = [
          ...document.querySelectorAll<HTMLElement>('[data-tone]'),
        ].find((candidate) => candidate.textContent === message)
        if (!node) throw new Error('Show the outcome on the stage card.')
        return node
      })
      expect(cardOutcome).toHaveAttribute('data-tone', tone)
    },
  )

  it('announces a stage-plan outcome from one live region only', async () => {
    const message = 'No work is scheduled: the 1 node is current.'
    vi.spyOn(getApi().pipeline, 'planWorkflow').mockResolvedValueOnce(
      fulfilledOutcome('noop', message),
    )
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    // The page line and the card both show the outcome; only the page line
    // announces it, so it names the stage the card sits beside.
    const line = 'Reconstruction: no work is scheduled; the 1 job is current.'
    await waitFor(() => expect(screen.getByText(line)).toBeInTheDocument())
    const announced = liveRegionsWith('the 1 job is current')
    expect(announced).toHaveLength(1)
    expect(announced[0]).toHaveTextContent(line)
    const card = [...document.querySelectorAll<HTMLElement>('[data-tone]')]
    expect(card.map((node) => node.textContent)).toEqual([
      'No work is scheduled: the 1 job is current.',
    ])
    expect(card[0]).not.toHaveAttribute('role')
    expect(card[0]).not.toHaveAttribute('aria-live')
  })

  it('removes a stage-plan outcome from the page line and its card on Dismiss', async () => {
    const reason = 'Brain FOV preparation failed, so this step did not run.'
    vi.spyOn(getApi().pipeline, 'planWorkflow').mockResolvedValueOnce(
      fulfilledOutcome('blocked', `Resolve 1 blocked node. ${reason}`),
    )
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    // The page line and the card state the outcome in the same words.
    const message = `No work is scheduled: 1 job is blocked. ${reason}`
    const line = `Reconstruction: no work is scheduled; 1 job is blocked. ${reason}`
    await waitFor(() => expect(screen.getByText(line)).toBeInTheDocument())
    expect(screen.getByText(message)).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss the workflow outcome' }),
    )
    // Dismissing the page line leaves no copy on the card to announce again.
    expect(screen.queryByText(line)).not.toBeInTheDocument()
    expect(screen.queryByText(message)).not.toBeInTheDocument()
  })

  it('keeps a refusal that only the stage card shows in a live region', async () => {
    const subjects = cohortWithReconCell('pending')
    const { rerender } = render(
      withProvider(<RunsScreen subjects={subjects} />),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    // The configuration changes while the confirmation is open.
    rerender(withProvider(<RunsScreen subjects={subjects} dirty />))
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    const card = await waitFor(() => {
      const node = [
        ...document.querySelectorAll<HTMLElement>('[data-tone]'),
      ].find(
        (candidate) =>
          candidate.textContent === 'Save the project before starting a run.',
      )
      if (!node) throw new Error('Show the refusal on the stage card.')
      return node
    })
    expect(card).toHaveAttribute('role', 'status')
  })

  it('leads the started-run notice with the runnable work of a partially blocked pass', async () => {
    const api = getApi()
    const message =
      'This pass runs 1 node; 1 blocked node will not run. Prepare Clinical merge.'
    const startedMessage = `Started: ${message}`
    const summary: WorkflowSummary = {
      planned: 1,
      started: 0,
      waiting: 0,
      blocked: 1,
      skipped: 0,
      message,
    }
    const planned: WorkflowResult = {
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
        resources: {
          queueSize: 2,
          availableMemoryGB: 16,
          memoryWarningGB: 10,
          lowMemory: false,
        },
        nodes: [
          {
            nodeId: '000-recon-sub-001',
            stepKey: 'recon',
            scope: 'subject',
            subjectId: 'sub-001',
            status: 'planned',
            dependencies: [],
          },
          {
            nodeId: '001-clinical-cohort',
            stepKey: 'clinical',
            scope: 'cohort',
            subjectId: null,
            status: 'blocked',
            dependencies: [],
            reason: 'Prepare Clinical merge.',
          },
        ],
        blockers: [
          {
            key: 'clinical',
            reason: 'Prepare Clinical merge.',
            kind: 'cohort',
          },
        ],
        summary,
      },
      summary,
    }
    vi.spyOn(api.pipeline, 'planWorkflow').mockResolvedValue(planned)
    const runSpy = vi.spyOn(api.pipeline, 'runWorkflow').mockResolvedValue({
      ...planned,
      runId: 'run-abcdef123456',
      disposition: 'started',
      summary: { ...summary, message: startedMessage },
    })
    render(
      withProvider(<RunsScreen subjects={cohortWithReconCell('pending')} />),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    // The page line names the stage and keeps one colon, after its name.
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .filter((node) =>
            node.textContent?.includes(`Reconstruction: started; ${message}`),
          ).length,
      ).toBeGreaterThan(0),
    )
    expect(runSpy).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers full-cohort reconstruction normalization from an actionable blocked outcome', async () => {
    const api = getApi()
    const plan = vi
      .spyOn(api.pipeline, 'planWorkflow')
      .mockResolvedValueOnce(
        fulfilledOutcome(
          'blocked',
          'Normalize the reconstruction cohort before starting downstream work because its current backends differ.',
          'normalize-reconstruction-cohort',
        ),
      )
    const run = vi.spyOn(api.pipeline, 'runWorkflow')
    const subjects = cohort(2).map((subject) => ({
      ...subject,
      stepStates: { brainfov: 'done' as const, recon: 'pending' as const },
    }))
    render(
      withProvider(
        <RunsScreen
          subjects={subjects}
          selection={['sub-001']}
          onSelectionChange={vi.fn()}
        />,
      ),
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Run Reconstruction',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    const actions = await screen.findByRole('group', {
      name: 'Blocked workflow actions',
    })
    const normalize = within(actions).getByRole('button', {
      name: 'Normalize full reconstruction cohort',
    })
    expect(screen.getByText('1 of 2 selected')).toBeInTheDocument()
    const blockedMessage =
      'Normalize the reconstruction cohort before starting downstream work because its current backends differ.'
    const blockedLine = `Reconstruction: normalize the reconstruction cohort before starting downstream work because its current backends differ.`
    expect(screen.getByText(blockedMessage)).toBeInTheDocument()
    expect(screen.getByText(blockedLine)).toBeInTheDocument()
    expect(
      screen
        .getAllByRole('status')
        .filter((node) => node.textContent?.includes(blockedLine)),
    ).toHaveLength(1)

    fireEvent.click(normalize)

    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2))
    expect(plan.mock.calls[1]?.[0].intent).toEqual({
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

  it('names the normalization button in its read-only review', async () => {
    // With Allow live runs off, the read-only review must name this flow's own
    // button, not "start the run again".
    const api = getApi()
    const live = structuredClone(RESOLVED_CFG)
    live.runtime.dryRun = false
    const planned: WorkflowResult = {
      ...fulfilledOutcome('noop', 'This pass runs 2 nodes.'),
      disposition: 'planned',
    }
    planned.plan = {
      ...planned.plan,
      planId: 'run-abcdef123456',
      digest: 'a'.repeat(64),
      configDigest: 'b'.repeat(64),
      qcDigest: 'c'.repeat(64),
      registryDigest: 'd'.repeat(64),
      environmentDigest: 'e'.repeat(64),
      resources: {
        queueSize: 2,
        availableMemoryGB: 16,
        memoryWarningGB: 10,
        lowMemory: false,
      },
      nodes: [planNode('recon', 'sub-001', 'planned')],
    }
    vi.spyOn(api.pipeline, 'planWorkflow')
      .mockResolvedValueOnce(
        fulfilledOutcome(
          'blocked',
          'Normalize the reconstruction cohort before starting downstream work because its current backends differ.',
          'normalize-reconstruction-cohort',
        ),
      )
      .mockResolvedValueOnce(planned)
    const subjects = cohort(2).map((subject) => ({
      ...subject,
      stepStates: { brainfov: 'done' as const, recon: 'pending' as const },
    }))
    render(
      withProvider(<RunsScreen cfg={live} subjects={subjects} />, {
        cfg: live,
      }),
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Run Reconstruction' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Normalize full reconstruction cohort',
      }),
    )

    await waitFor(() => expect(workflowReview.inspected).toHaveLength(1))
    expect(workflowReview.inspected[0]?.slice(1)).toEqual([
      'run',
      'safe-execution-off',
      'Normalize full reconstruction cohort',
    ])
  })

  it('states a Run all plan in which nothing runs as a fact beside View blockers', async () => {
    const reason = 'Reconstruction failed, so this step did not run.'
    const base = fulfilledOutcome(
      'blocked',
      `Resolve 2 blocked nodes. ${reason} 1 more reason applies.`,
    )
    const blocked: WorkflowResult = {
      ...base,
      plan: {
        ...base.plan,
        blockers: [{ key: 'enigma', kind: 'cohort', reason }],
      },
    }
    vi.spyOn(getApi().pipeline, 'planWorkflow').mockResolvedValueOnce(blocked)
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
        />,
      ),
    )

    fireEvent.click(await screen.findByRole('button', { name: /^Run all/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    const notice = `No work is scheduled: 2 jobs are blocked. ${reason} 1 more reason applies.`
    await waitFor(() => expect(liveRegionsWith(notice)).toHaveLength(1))
    // The action stays with the outcome's control, not in its text.
    const actions = screen.getByRole('group', {
      name: 'Blocked workflow actions',
    })
    expect(
      within(actions).getByRole('button', { name: 'View blockers' }),
    ).toBeInTheDocument()
    expect(
      screen
        .getAllByRole('status')
        .map((node) => node.textContent ?? '')
        .join(' '),
    ).not.toMatch(/Resolve/)
  })

  it('keeps the blockers of a blocked plan reachable from the Runs notice', async () => {
    const api = getApi()
    const reason =
      'Register every subject before starting the workflow because sub-001 is unregistered.'
    vi.spyOn(api.pipeline, 'planWorkflow').mockResolvedValueOnce(
      fulfilledOutcome('blocked', reason, 'open-registry'),
    )
    render(
      withProvider(
        <>
          <RunsScreen
            cfg={DEFAULT_PROJECT_CONFIG}
            subjects={cohortWithReconCell('pending')}
          />
          <RouteProbe />
        </>,
      ),
    )

    fireEvent.click(await screen.findByRole('button', { name: /^Run all/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Review plan' }))

    const actions = await screen.findByRole('group', {
      name: 'Blocked workflow actions',
    })
    fireEvent.click(
      within(actions).getByRole('button', { name: 'View blockers' }),
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(reason)).toBeInTheDocument()

    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Open Registry' }),
    )
    expect(screen.getByTestId('route-probe')).toHaveTextContent('registry:null')
  })

  it('announces only the job that enters or leaves the in-flight list', async () => {
    const api = getApi()
    const running = makeJob({
      id: '#job-a',
      runId: 'run-1',
      subjectId: 'sub-001',
      stepKey: 'recon',
      status: 'running',
    })
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-1', 'running')], [running]),
    )
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
        />,
      ),
    )
    expect(await screen.findByText('sub-001')).toBeInTheDocument()
    const announcer = screen.getByTestId('in-flight-announcement')
    expect(announcer).toHaveAttribute('aria-live', 'polite')
    // The first projection is the state on arrival, not a change.
    expect(announcer.textContent).toBe('')
    // The visible rows sit outside every live region, so none is re-read.
    expect(screen.getByText('sub-001').closest('[aria-live]')).toBeNull()

    const entering = makeJob({
      id: '#job-b',
      runId: 'run-1',
      subjectId: 'sub-002',
      stepKey: 'recon',
      status: 'running',
    })
    const event = (job: Job, sequence: number): RuntimeEvent => ({
      kind: 'job',
      job,
      projectId: RUNS_PROJECT.projectId,
      projectEpoch: RUNS_PROJECT.epoch,
      sidecarGeneration: 1,
      sequence,
      runId: 'run-1',
      at: sequence,
    })

    await act(async () => {
      publish?.(event(entering, 2))
    })
    await waitFor(() =>
      expect(announcer.textContent).toBe('Added Reconstruction for sub-002.'),
    )

    await act(async () => {
      publish?.(event({ ...entering, status: 'done', endedAt: 3 }, 3))
    })
    await waitFor(() =>
      expect(announcer.textContent).toBe('Removed Reconstruction for sub-002.'),
    )
    expect(announcer.textContent).not.toContain('sub-001')
  })

  it("announces a job's new state in the words its In flight chip shows", async () => {
    // The live region uses the chip's word "Canceling", not the sidecar's
    // spelling "cancelling".
    const api = getApi()
    const running = makeJob({
      id: '#job-a',
      runId: 'run-1',
      subjectId: 'sub-001',
      stepKey: 'recon',
      status: 'running',
    })
    vi.spyOn(api.runtime, 'bootstrap').mockResolvedValue(
      runtimeSnapshot([runSnapshot('run-1', 'running')], [running]),
    )
    let publish: ((event: RuntimeEvent) => void) | null = null
    vi.spyOn(api.runtime, 'onEvent').mockImplementation((cb) => {
      publish = cb
      return () => {}
    })
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('pending')}
        />,
      ),
    )
    expect(await screen.findByText('sub-001')).toBeInTheDocument()
    const announcer = screen.getByTestId('in-flight-announcement')

    await act(async () => {
      publish?.({
        kind: 'job',
        job: { ...running, status: 'cancelling' },
        projectId: RUNS_PROJECT.projectId,
        projectEpoch: RUNS_PROJECT.epoch,
        sidecarGeneration: 1,
        sequence: 2,
        runId: 'run-1',
        at: 2,
      })
    })
    await waitFor(() =>
      expect(announcer.textContent).toBe(
        'Reconstruction for sub-001 is now canceling.',
      ),
    )
    expect(screen.getByText('Canceling')).toBeInTheDocument()
  })

  it('claims nothing to resume, retry, or clean up only once the runtime restore answers', async () => {
    // After a rejected runtime restore no run history is known, so the Resume
    // card must not say there is nothing to resume; the run dock gates the same
    // sentence on the authoritative runtime.
    vi.spyOn(getApi().runtime, 'bootstrap').mockRejectedValue(
      new Error('Runtime state could not be restored.'),
    )
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('done')}
        />,
      ),
    )
    await screen.findByRole('alert')
    const resume = await screen.findByRole('button', { name: 'Resume' })
    expect(resume).toBeDisabled()
    expect(
      screen.queryAllByText(/^Nothing to (resume|retry|clean up)/),
    ).toHaveLength(0)
    // The Resume, Retry canceled, and Clean up cards state the unknown.
    expect(screen.getAllByText(RUN_HISTORY_NOT_RESTORED)).toHaveLength(3)
  })

  it('retries the runtime restore from the restore alert', async () => {
    // The restore alert's Retry restores the runtime, not only subject
    // discovery, so the alert and the cards recover without a reload.
    const bootstrap = vi
      .spyOn(getApi().runtime, 'bootstrap')
      .mockRejectedValueOnce(new Error('Runtime state could not be restored.'))
    const refresh = vi.fn()
    render(
      withProvider(
        <RunsScreen
          cfg={DEFAULT_PROJECT_CONFIG}
          subjects={cohortWithReconCell('done')}
          refresh={refresh}
        />,
      ),
    )
    const alert = await screen.findByRole('alert')
    expect(screen.getAllByText(RUN_HISTORY_NOT_RESTORED)).toHaveLength(3)
    const calls = bootstrap.mock.calls.length
    fireEvent.click(within(alert).getByRole('button', { name: /^Retry/ }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(bootstrap.mock.calls.length).toBeGreaterThan(calls)
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.queryAllByText(RUN_HISTORY_NOT_RESTORED)).toHaveLength(0)
    // With the history restored, Resume has nothing to act on and says so in
    // its tooltip.
    expect(
      screen.getByRole('button', { name: 'Resume' }).closest('[title]'),
    ).toHaveAttribute('title', expect.stringMatching(/^Nothing to resume/))
  })

  it('should humanize a bootstrap error and keep the raw message recoverable', async () => {
    const api = getApi()
    vi.spyOn(api.runtime, 'bootstrap').mockRejectedValue(
      new Error('permission_denied'),
    )
    render(withProvider(<RunsScreen />))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Permission denied')
    expect(alert.textContent).toContain('permission_denied')
  })
})
