/** Tests for {@link AppProvider} state and preference persistence. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { version as APP_VERSION } from '../../../package.json'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { AppProvider, useApp, type RunsFeedback } from './context'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type {
  HostState,
  ProjectOpenResult,
  ProjectSaveResult,
  QcWriteResult,
  SupraspinaApi,
  WorkflowResult,
} from '../../shared/contract'
import { installMockSupraspina } from '../ipc/mock'
import { makeMockCohort } from '../ipc/mock'
import type { Subject } from '../../shared/types'

const CREATED_PROJECT: ProjectOpenResult = {
  project: {
    projectId: 'created-project',
    root: '/p',
    configPath: '/p/supraspina.project.json',
    epoch: 1,
  },
  cfg: {
    ...DEFAULT_PROJECT_CONFIG,
    project: { ...DEFAULT_PROJECT_CONFIG.project, name: 'Created project' },
    paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/p' },
  },
  configSha256: '0'.repeat(64),
}

/** Read the resolved density so a stale value surfaces as `undefined`. */
function DensityProbe(): ReactNode {
  const { density, tweaks } = useApp()
  return (
    <output data-testid="probe">{`${tweaks.density}:${density.pad}`}</output>
  )
}

/** Surface the stored theme choice separately from its live resolution. */
function ThemeProbe(): ReactNode {
  const { tweaks, resolvedTheme } = useApp()
  return (
    <output data-testid="theme-probe">
      {`${tweaks.theme}:${resolvedTheme}`}
    </output>
  )
}

/** Read and advance the lifted wizard step to test shell ownership. */
function WizardStepProbe(): ReactNode {
  const { wizardStep, setWizardStep } = useApp()
  return (
    <button onClick={() => setWizardStep((s) => s + 1)}>
      {`step:${wizardStep}`}
    </button>
  )
}

beforeEach(() => {
  // installMockSupraspina keeps a bridge that is already installed, so without
  // this every test would share one mock and inherit the state an earlier
  // test left in it, such as a project the sidecar attached.
  delete (globalThis as { supraspina?: SupraspinaApi }).supraspina
})

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AppProvider tweak persistence', () => {
  it('defaults a brand-new profile to compact density', () => {
    render(
      <AppProvider>
        <DensityProbe />
      </AppProvider>,
    )
    const probe = screen.getByTestId('probe')
    expect(probe).toHaveTextContent('compact:')
    expect(probe.textContent).not.toContain('undefined')
  })

  it('resolves System before first paint and responds live to OS theme changes', async () => {
    let dark = true
    const listeners = new Set<() => void>()
    const mediaQuery = {
      get matches() {
        return dark
      },
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: (_event: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => true,
    }
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mediaQuery),
    )

    render(
      <AppProvider>
        <ThemeProbe />
      </AppProvider>,
    )
    expect(screen.getByTestId('theme-probe')).toHaveTextContent('system:dark')

    act(() => {
      dark = false
      for (const listener of listeners) listener()
    })
    await waitFor(() =>
      expect(screen.getByTestId('theme-probe')).toHaveTextContent(
        'system:light',
      ),
    )
  })
})

const FIRST_RUN_KEY = 'supraspinaFirstRunDone'

/** Surface the first-run flag and a button to mark it done. */
function FirstRunProbe(): ReactNode {
  const { firstRun, markFirstRunDone } = useApp()
  return (
    <button type="button" onClick={markFirstRunDone}>
      {firstRun ? 'first-run' : 'returning'}
    </button>
  )
}

describe('AppProvider first-run detection', () => {
  it('reports first-run when no sentinel is persisted', () => {
    render(
      <AppProvider>
        <FirstRunProbe />
      </AppProvider>,
    )
    expect(screen.getByRole('button')).toHaveTextContent('first-run')
  })

  it('reports returning when the sentinel is present', () => {
    localStorage.setItem(FIRST_RUN_KEY, '1')
    render(
      <AppProvider>
        <FirstRunProbe />
      </AppProvider>,
    )
    expect(screen.getByRole('button')).toHaveTextContent('returning')
  })

  it('persists the sentinel and flips to returning when marked done', () => {
    render(
      <AppProvider>
        <FirstRunProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveTextContent('returning')
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBe('1')
  })
})

describe('AppProvider wizard step', () => {
  it('defaults to step 0 and updates through the lifted setter', () => {
    render(
      <AppProvider>
        <WizardStepProbe />
      </AppProvider>,
    )
    expect(screen.getByRole('button')).toHaveTextContent('step:0')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveTextContent('step:1')
  })
})

/** Surface the wizard state and project gate as `step:maxReached:hasProject`. */
function GateResetProbe(): ReactNode {
  const {
    wizardStep,
    wizardMaxReached,
    hasProject,
    setWizardStep,
    setWizardMaxReached,
    markProjectCreated,
    openProject,
  } = useApp()
  return (
    <div>
      <output data-testid="wiz">
        {`${wizardStep}:${wizardMaxReached}:${hasProject}`}
      </output>
      <button
        type="button"
        onClick={() => {
          setWizardStep(3)
          setWizardMaxReached(4)
        }}
      >
        advance
      </button>
      <button type="button" onClick={() => markProjectCreated(CREATED_PROJECT)}>
        create
      </button>
      <button
        type="button"
        onClick={() => void openProject('/p/supraspina.project.json')}
      >
        open
      </button>
    </div>
  )
}

/** Read the QC tool-status item and drive the saved ENIGMA backend. */
function QcBackendProbe(): ReactNode {
  const { toolStatus, cfg, setCfg, markProjectCreated } = useApp()
  const qc = toolStatus?.items.find((item) => item.id === 'qc')
  return (
    <div>
      <output data-testid="qc">{`${qc?.status ?? 'none'}`}</output>
      <button type="button" onClick={() => markProjectCreated(CREATED_PROJECT)}>
        create
      </button>
      <button
        type="button"
        onClick={() =>
          setCfg({
            ...cfg,
            steps: {
              ...cfg.steps,
              enigma: {
                ...cfg.steps.enigma,
                params: { ...cfg.steps.enigma.params, backend: 'mcr' },
              },
            },
          })
        }
      >
        select-mcr
      </button>
    </div>
  )
}

/** Read and set the Results deep-link stage to test shell ownership. */
function ResultsStageProbe(): ReactNode {
  const { resultsStage, setResultsStage } = useApp()
  return (
    <button onClick={() => setResultsStage('recon')}>
      {`stage:${resultsStage}`}
    </button>
  )
}

function ProjectEpochProbe(): ReactNode {
  const { projectEpoch, openProject } = useApp()
  return (
    <button
      type="button"
      onClick={() => void openProject('/p/supraspina.project.json')}
    >
      {`epoch:${projectEpoch}`}
    </button>
  )
}

/** Surface the Runs notice and keep the setter of the project it rendered in. */
function RunsFeedbackProbe({
  capturedRef,
}: {
  capturedRef: { current: Dispatch<SetStateAction<RunsFeedback>> | null }
}): ReactNode {
  const { projectEpoch, runsFeedback, setRunsFeedback, openProject } = useApp()
  return (
    <div>
      <output data-testid="runs-feedback">
        {`epoch:${projectEpoch}|notice:${runsFeedback.notice ?? 'none'}`}
      </output>
      <button
        type="button"
        onClick={() => void openProject('/p/supraspina.project.json')}
      >
        open
      </button>
      <button
        type="button"
        onClick={() => {
          capturedRef.current = setRunsFeedback
        }}
      >
        capture
      </button>
      <button
        type="button"
        onClick={() =>
          setRunsFeedback((previous) => ({
            ...previous,
            notice: `Notice for epoch ${projectEpoch}.`,
          }))
        }
      >
        notice
      </button>
    </div>
  )
}

function ReattachProbe(): ReactNode {
  const { markProjectCreated, subjects } = useApp()
  return (
    <button type="button" onClick={() => markProjectCreated(CREATED_PROJECT)}>
      {`subjects:${subjects.length}`}
    </button>
  )
}

function SaveDiscardProbe(): ReactNode {
  const {
    cfg,
    configRevision,
    savedRevision,
    dirty,
    markProjectCreated,
    setCfg,
    saveProject,
    discardChanges,
    safeExecution,
    setSafeExecution,
  } = useApp()
  const rename = (name: string): void => {
    setCfg({ ...cfg, project: { ...cfg.project, name } })
  }
  return (
    <div>
      <output data-testid="save-state">
        {`${cfg.project.name}|${configRevision}|${savedRevision}|${dirty}`}
      </output>
      <output data-testid="safe-state">{String(safeExecution)}</output>
      <button type="button" onClick={() => markProjectCreated(CREATED_PROJECT)}>
        create
      </button>
      <button type="button" onClick={() => rename('Saved draft')}>
        edit saved draft
      </button>
      <button type="button" onClick={() => void saveProject()}>
        save
      </button>
      <button type="button" onClick={() => rename('Later edit')}>
        edit later
      </button>
      <button type="button" onClick={() => void discardChanges()}>
        discard
      </button>
      <button type="button" onClick={() => setSafeExecution(!safeExecution)}>
        toggle safe
      </button>
    </div>
  )
}

function CohortSelectionProbe(): ReactNode {
  const {
    cfg,
    projectEpoch,
    projectRef,
    subjects,
    executionTarget,
    markProjectCreated,
    newProject,
    setCfg,
    setSelection,
    toggleSelection,
    releaseLaunchSelection,
    refreshSubject,
    refreshSubjects,
    discoveryAnswered,
    subjectsDiscovering,
    subjectsDiscoveredAt,
  } = useApp()
  const target =
    executionTarget.mode === 'all'
      ? 'all'
      : `explicit:${executionTarget.subjectIds.join(',')}`
  return (
    <div>
      <output data-testid="cohort-state">
        {`${projectRef?.projectId ?? 'none'}|${subjects
          .map(
            (subject) =>
              `${subject.id}:${subject.qc ?? 'unreviewed'}:${String(subject.analysisEligible)}`,
          )
          .join(';')}|${target}`}
      </output>
      <output data-testid="discovery-answered">
        {String(discoveryAnswered)}
      </output>
      <output data-testid="discovery-progress">
        {`${String(subjectsDiscovering)}|${subjectsDiscoveredAt ?? 'never'}`}
      </output>
      <button type="button" onClick={() => markProjectCreated(CREATED_PROJECT)}>
        create A
      </button>
      <button
        type="button"
        onClick={() =>
          markProjectCreated({
            project: {
              projectId: 'project-b',
              root: '/q',
              configPath: '/q/supraspina.project.json',
              epoch: projectEpoch,
            },
            cfg: {
              ...DEFAULT_PROJECT_CONFIG,
              project: {
                ...DEFAULT_PROJECT_CONFIG.project,
                name: 'Project B',
              },
              paths: { ...DEFAULT_PROJECT_CONFIG.paths, projectRoot: '/q' },
            },
            configSha256: '1'.repeat(64),
          })
        }
      >
        create B
      </button>
      <button type="button" onClick={() => void newProject()}>
        new
      </button>
      <button
        type="button"
        onClick={() =>
          setCfg({
            ...cfg,
            project: { ...cfg.project, name: `${cfg.project.name} edited` },
          })
        }
      >
        edit config
      </button>
      <button
        type="button"
        onClick={() =>
          setCfg({
            ...cfg,
            subjects: { ...cfg.subjects, exclude: ['sub-002'] },
          })
        }
      >
        exclude sub-002
      </button>
      <button
        type="button"
        onClick={() =>
          setSelection(new Set(['sub-001', 'sub-002', 'not-discovered']))
        }
      >
        select candidates
      </button>
      <button type="button" onClick={() => toggleSelection('not-discovered')}>
        toggle unknown
      </button>
      <button
        type="button"
        onClick={() => releaseLaunchSelection(['sub-001', 'sub-002'])}
      >
        release launched
      </button>
      <button type="button" onClick={() => toggleSelection('sub-002')}>
        toggle 2
      </button>
      <button
        type="button"
        onClick={() => void refreshSubject('sub-001').catch(() => undefined)}
      >
        refresh 1
      </button>
      <button
        type="button"
        onClick={() => void refreshSubject('sub-002').catch(() => undefined)}
      >
        refresh 2
      </button>
      <button type="button" onClick={refreshSubjects}>
        rediscover
      </button>
    </div>
  )
}

const QC_EVIDENCE = {
  evidenceVersion: 1 as const,
  reviewer: 'fixture-reviewer',
  reviewedAt: '2026-09-24T12:00:00.000Z',
  galleries: [],
}

/** Build one committed QC write for a subject. */
function qcWrite(
  subjectId: string,
  verdict: QcWriteResult['verdict'],
  revision: number,
  evidence = true,
  note = '',
): QcWriteResult {
  return {
    subjectId,
    verdict,
    note,
    tags: [],
    reviewEvidence: evidence ? QC_EVIDENCE : null,
    revision,
    updatedAt: '2026-09-24T12:00:00.000Z',
  }
}

/** Apply named QC writes and list every row's QC fields. */
function QcWriteProbe({
  writes,
}: {
  writes: Record<string, QcWriteResult>
}): ReactNode {
  const {
    projectRef,
    subjects,
    markProjectCreated,
    applyQcWrite,
    refreshSubject,
  } = useApp()
  return (
    <div>
      <output data-testid="qc-rows">
        {subjects
          .map(
            (subject) =>
              `${subject.id}:${subject.qc ?? 'unreviewed'}:${subject.recordedQcVerdict ?? 'none'}:${String(subject.qcReviewEvidencePresent)}:${String(subject.analysisEligible)}:${subject.notes}:${subject.qcRevision ?? 0}`,
          )
          .join(';')}
      </output>
      <button type="button" onClick={() => markProjectCreated(CREATED_PROJECT)}>
        create
      </button>
      <button
        type="button"
        onClick={() => void refreshSubject('sub-001').catch(() => undefined)}
      >
        refresh 1
      </button>
      {Object.entries(writes).map(([name, result]) => (
        <button
          key={name}
          type="button"
          onClick={() => {
            if (projectRef) applyQcWrite(projectRef, result)
          }}
        >
          {name}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          if (!projectRef) return
          applyQcWrite(
            { ...projectRef, projectId: 'another-project' },
            qcWrite('sub-001', 'defer', 99),
          )
        }}
      >
        write for another project
      </button>
    </div>
  )
}

/**
 * Report the open project as attached, as the sidecar does once the project
 * was created or opened through it. markProjectCreated alone leaves the mock
 * sidecar unattached, and an unattached sidecar starts an attachment
 * discovery that can answer in the middle of a test's steps.
 */
function attachSidecar(api: SupraspinaApi): void {
  const read = api.host.getState.bind(api.host)
  vi.spyOn(api.host, 'getState').mockImplementation(async () => {
    const state = await read()
    return { ...state, sidecar: { ...state.sidecar, projectAttached: true } }
  })
}

/**
 * Let every pending promise callback run: a zero-delay timer fires only after
 * the microtask queue is empty, however slow the machine is.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function eligibleSubject(id: string): Subject {
  const subject = makeMockCohort(1, id === 'sub-001' ? 11 : 12)[0]
  if (!subject) throw new Error('Provide a mock subject.')
  return {
    ...subject,
    id,
    qc: 'pass',
    analysisEligible: true,
    unavailableReason: null,
  }
}

describe('AppProvider results deep-link', () => {
  it('defaults the results stage to null and updates through the setter', () => {
    render(
      <AppProvider>
        <ResultsStageProbe />
      </AppProvider>,
    )
    expect(screen.getByRole('button')).toHaveTextContent('stage:null')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveTextContent('stage:recon')
  })
})

describe('AppProvider project generation recovery', () => {
  it('reserves a project epoch newer than a prior BrowserWindow page session', async () => {
    const api = installMockSupraspina()
    const open = vi.spyOn(api.project, 'open')
    const first = render(
      <AppProvider>
        <ProjectEpochProbe />
      </AppProvider>,
    )

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(open).toHaveBeenCalledOnce())
    const firstAcceptedEpoch = open.mock.calls[0]?.[0].epoch ?? 0
    first.unmount()
    // Model a new BrowserWindow with fresh session storage while main retains
    // the last accepted project generation.
    sessionStorage.clear()

    render(
      <AppProvider>
        <ProjectEpochProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    const reloadedEpoch = open.mock.calls[1]?.[0].epoch ?? 0

    expect(Number.isSafeInteger(reloadedEpoch)).toBe(true)
    expect(reloadedEpoch).toBeGreaterThan(firstAcceptedEpoch)
    expect(Number(localStorage.getItem('supraspina:projectEpoch:v1'))).toBe(
      reloadedEpoch,
    )
  })

  it('reattaches an open project once per ready detached sidecar generation', async () => {
    const api = installMockSupraspina()
    let hostListener: ((state: HostState) => void) | null = null
    let currentHost: HostState = {
      mode: 'electron',
      platform: 'linux',
      captionMode: 'custom',
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
        capabilities: [],
        runtimeId: 'runtime-1',
        projectAttached: true,
        retryable: false,
        detail: null,
      },
    }
    vi.spyOn(api.host, 'getState').mockImplementation(async () => currentHost)
    vi.spyOn(api.host, 'onState').mockImplementation((listener) => {
      hostListener = listener
      return () => {
        hostListener = null
      }
    })
    const discover = vi.spyOn(api.subjects, 'discover')
    render(
      <AppProvider>
        <ReattachProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(discover).toHaveBeenCalled())
    discover.mockClear()

    currentHost = {
      ...currentHost,
      sidecar: {
        ...currentHost.sidecar,
        generation: 2,
        runtimeId: 'runtime-2',
        projectAttached: false,
      },
    }
    act(() => hostListener?.(currentHost))

    await waitFor(() => expect(discover).toHaveBeenCalledOnce())
    expect(discover).toHaveBeenCalledWith({
      project: CREATED_PROJECT.project,
      cfg: CREATED_PROJECT.cfg,
      configRevision: 0,
    })
  })

  it('retries a rejected attachment in the same sidecar generation', async () => {
    const api = installMockSupraspina()
    let hostListener: ((state: HostState) => void) | null = null
    const attachedHost: HostState = {
      mode: 'electron',
      platform: 'linux',
      captionMode: 'custom',
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
        capabilities: [],
        runtimeId: 'runtime-1',
        projectAttached: true,
        retryable: false,
        detail: null,
      },
    }
    const detachedHost: HostState = {
      ...attachedHost,
      sidecar: {
        ...attachedHost.sidecar,
        generation: 2,
        runtimeId: 'runtime-2',
        projectAttached: false,
      },
    }
    let currentHost = attachedHost
    vi.spyOn(api.host, 'getState').mockImplementation(async () => currentHost)
    vi.spyOn(api.host, 'onState').mockImplementation((listener) => {
      hostListener = listener
      return () => {
        hostListener = null
      }
    })
    const discover = vi.spyOn(api.subjects, 'discover')
    render(
      <AppProvider>
        <ReattachProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(discover).toHaveBeenCalled())
    discover.mockClear()
    discover
      .mockRejectedValueOnce(new Error('sidecar still warming'))
      .mockResolvedValueOnce([])

    currentHost = detachedHost
    act(() => hostListener?.(detachedHost))

    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2), {
      timeout: 1_500,
    })
    expect(discover.mock.calls[0]?.[0].project).toEqual(CREATED_PROJECT.project)
    expect(discover.mock.calls[1]?.[0].project).toEqual(CREATED_PROJECT.project)
  })
})

describe('AppProvider Runs feedback', () => {
  it('keeps the current project feedback when an earlier project writes late', async () => {
    installMockSupraspina()
    const capturedRef: {
      current: Dispatch<SetStateAction<RunsFeedback>> | null
    } = { current: null }
    render(
      <AppProvider>
        <RunsFeedbackProbe capturedRef={capturedRef} />
      </AppProvider>,
    )
    const readEpoch = (): number =>
      Number(
        /epoch:(\d+)/.exec(
          screen.getByTestId('runs-feedback').textContent ?? '',
        )?.[1],
      )
    const initialEpoch = readEpoch()

    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    await waitFor(() => expect(readEpoch()).toBeGreaterThan(initialEpoch))
    const epochA = readEpoch()
    fireEvent.click(screen.getByRole('button', { name: 'capture' }))
    const setFeedbackA = capturedRef.current
    if (!setFeedbackA) throw new Error('Capture the project A setter.')

    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    await waitFor(() => expect(readEpoch()).toBeGreaterThan(epochA))
    const epochB = readEpoch()
    fireEvent.click(screen.getByRole('button', { name: 'notice' }))
    const noticeB = `epoch:${epochB}|notice:Notice for epoch ${epochB}.`
    expect(screen.getByTestId('runs-feedback')).toHaveTextContent(noticeB)

    // A plan started in project A settles after project B opened.
    act(() =>
      setFeedbackA({
        error: null,
        notice: 'A late notice from project A.',
        outcome: null,
        stageOutcome: null,
      }),
    )
    expect(screen.getByTestId('runs-feedback')).toHaveTextContent(noticeB)
    act(() => setFeedbackA((previous) => ({ ...previous, notice: null })))
    expect(screen.getByTestId('runs-feedback')).toHaveTextContent(noticeB)
  })
})

/** A started run's result whose plan blocks the given subjects for a reason. */
function startedResult(
  runId: string | null,
  blockedSubjectIds: readonly string[],
): WorkflowResult {
  const reason =
    'Choose a fresh derivatives namespace because detector-complete Reconstruction output has no matching current receipt; preserve the existing tree.'
  const subjectIds = ['sub-001', ...blockedSubjectIds]
  const summary = {
    planned: 1,
    started: 1,
    waiting: 0,
    blocked: blockedSubjectIds.length,
    skipped: 0,
    message: 'This pass runs 1 node.',
  }
  return {
    runId,
    disposition: runId ? 'started' : 'planned',
    plan: {
      planId: `plan-${runId ?? 'none'}`,
      analysisCohort: { subjectIds, sha256: '1'.repeat(64) },
      selectedSubset: { subjectIds, sha256: '2'.repeat(64) },
      nodes: subjectIds.map((subjectId) => ({
        nodeId: `recon-${subjectId}`,
        stepKey: 'recon',
        scope: 'subject',
        subjectId,
        dependencies: [],
        ...(blockedSubjectIds.includes(subjectId)
          ? { status: 'blocked' as const, reason }
          : { status: 'planned' as const }),
      })),
      blockers: [],
      summary,
    },
    summary,
  }
}

/** Surface the kept plan records and the controls that change them. */
function RunPlanRecordsProbe({
  recordRef,
  capturedRef,
}: {
  recordRef: { current: ((result: WorkflowResult) => void) | null }
  capturedRef: { current: ((result: WorkflowResult) => void) | null }
}): ReactNode {
  const {
    projectEpoch,
    runPlanRecords,
    recordRunPlan,
    trackPlan,
    setRunsFeedback,
    openProject,
  } = useApp()
  useEffect(() => {
    recordRef.current = recordRunPlan
  }, [recordRef, recordRunPlan])
  const kept = [...runPlanRecords]
    .map(
      ([runId, records]) =>
        `${runId}=${records.map((record) => `${record.subjectId}:${record.status}`).join(',')}`,
    )
    .join(' ')
  return (
    <div>
      <output data-testid="plan-records">{`epoch:${projectEpoch}|${kept}`}</output>
      <button
        type="button"
        onClick={() => void openProject('/p/supraspina.project.json')}
      >
        open
      </button>
      <button
        type="button"
        onClick={() => {
          capturedRef.current = recordRunPlan
        }}
      >
        capture
      </button>
      <button
        type="button"
        onClick={() => {
          trackPlan({
            label: 'Planning the workflow...',
            waitReason: 'Supraspina is planning the workflow.',
            card: null,
          })(true)
          setRunsFeedback((previous) => ({ ...previous, outcome: null }))
        }}
      >
        plan
      </button>
    </div>
  )
}

describe('AppProvider run plan records', () => {
  it('keeps the not-run plan nodes of each started run past later plans', async () => {
    installMockSupraspina()
    const recordRef: { current: ((result: WorkflowResult) => void) | null } = {
      current: null,
    }
    const capturedRef: { current: ((result: WorkflowResult) => void) | null } =
      { current: null }
    const record = (result: WorkflowResult): void => recordRef.current?.(result)
    render(
      <AppProvider>
        <RunPlanRecordsProbe recordRef={recordRef} capturedRef={capturedRef} />
      </AppProvider>,
    )
    const shown = (): string =>
      screen.getByTestId('plan-records').textContent ?? ''
    const readEpoch = (): number => Number(/epoch:(\d+)/.exec(shown())?.[1])
    const initialEpoch = readEpoch()
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    await waitFor(() => expect(readEpoch()).toBeGreaterThan(initialEpoch))
    const epochA = readEpoch()

    // Only the blocked node is kept, and a plan that started no run adds none.
    act(() => record(startedResult('run-conflict', ['sub-902'])))
    act(() => record(startedResult(null, ['sub-903'])))
    act(() => record(startedResult('run-clear', [])))
    expect(shown()).toBe(`epoch:${epochA}|run-conflict=sub-902:blocked`)

    // Preparing another plan clears the Runs outcome, not the records.
    fireEvent.click(screen.getByRole('button', { name: 'plan' }))
    expect(shown()).toBe(`epoch:${epochA}|run-conflict=sub-902:blocked`)

    // The newest 100 runs are kept.
    act(() => {
      for (let index = 0; index < 100; index += 1) {
        record(startedResult(`run-${index}`, ['sub-902']))
      }
    })
    expect(shown()).not.toContain('run-conflict=')
    expect(shown()).toContain('run-0=sub-902:blocked')
    expect(shown()).toContain('run-99=sub-902:blocked')

    // A run of the earlier project that starts after the next one opened
    // leaves the newer project's records alone.
    fireEvent.click(screen.getByRole('button', { name: 'capture' }))
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    await waitFor(() => expect(readEpoch()).toBeGreaterThan(epochA))
    const epochB = readEpoch()
    expect(shown()).toBe(`epoch:${epochB}|`)
    act(() => capturedRef.current?.(startedResult('run-late', ['sub-902'])))
    expect(shown()).toBe(`epoch:${epochB}|`)
  })
})

describe('AppProvider authoritative analysis selection', () => {
  it('prunes Pass-to-Fail transitions without reselecting Fail-to-Pass rows', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const first = eligibleSubject('sub-001')
    const second = eligibleSubject('sub-002')
    vi.spyOn(api.subjects, 'discover').mockResolvedValue([first, second])
    const refreshOne = vi
      .spyOn(api.subjects, 'refreshOne')
      .mockResolvedValueOnce({
        ...first,
        qc: 'fail',
        analysisEligible: false,
        unavailableReason:
          'Exclude this subject from analysis because QC is Fail.',
      })
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({
        ...second,
        qc: 'fail',
        analysisEligible: false,
        unavailableReason:
          'Exclude this subject from analysis because QC is Fail.',
      })
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:pass:true;sub-002:pass:true|all',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'select candidates' }))
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'explicit:sub-001,sub-002',
    )
    fireEvent.click(screen.getByRole('button', { name: 'toggle unknown' }))
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'explicit:sub-001,sub-002',
    )

    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:fail:false;sub-002:pass:true|explicit:sub-002',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:pass:true;sub-002:pass:true|explicit:sub-002',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'refresh 2' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:pass:true;sub-002:fail:false|explicit:',
      ),
    )
    expect(refreshOne).toHaveBeenNthCalledWith(1, {
      project: CREATED_PROJECT.project,
      cfg: CREATED_PROJECT.cfg,
      configRevision: 0,
      subjectId: 'sub-001',
    })
  })

  it('hands a launched selection back to the full cohort, not a changed one', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    vi.spyOn(api.subjects, 'discover').mockResolvedValue([
      eligibleSubject('sub-001'),
      eligibleSubject('sub-002'),
    ])
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )
    const state = () => screen.getByTestId('cohort-state')

    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() => expect(state()).toHaveTextContent(/\|all$/))
    fireEvent.click(screen.getByRole('button', { name: 'select candidates' }))
    fireEvent.click(screen.getByRole('button', { name: 'toggle 2' }))
    // A selection changed since the launch is the operator's next choice.
    fireEvent.click(screen.getByRole('button', { name: 'release launched' }))
    expect(state()).toHaveTextContent(/\|explicit:sub-001$/)

    fireEvent.click(screen.getByRole('button', { name: 'toggle 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'release launched' }))
    expect(state()).toHaveTextContent(/\|all$/)
  })

  it('ignores superseded and stale-config subject refresh responses', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const first = eligibleSubject('sub-001')
    vi.spyOn(api.subjects, 'discover').mockResolvedValue([first])
    const resolvers: Array<(subject: Subject) => void> = []
    vi.spyOn(api.subjects, 'refreshOne').mockImplementation(
      () =>
        new Promise<Subject>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:pass:true',
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    const firstResolver = resolvers[0]
    const secondResolver = resolvers[1]
    if (!firstResolver || !secondResolver) {
      throw new Error('Provide two pending refreshes.')
    }
    act(() => secondResolver({ ...first, qc: 'defer', analysisEligible: true }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:defer:true',
      ),
    )
    act(() => firstResolver({ ...first, qc: 'fail', analysisEligible: false }))
    await act(async () => undefined)
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'sub-001:defer:true',
    )

    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    const staleConfigResolver = resolvers[2]
    if (!staleConfigResolver) throw new Error('Provide a pending refresh.')
    fireEvent.click(screen.getByRole('button', { name: 'edit config' }))
    act(() =>
      staleConfigResolver({ ...first, qc: 'fail', analysisEligible: false }),
    )
    await act(async () => undefined)
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'sub-001:defer:true',
    )
  })

  it('drops a newly excluded subject before rediscovery answers', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const resolvers: Array<(subjects: Subject[]) => void> = []
    vi.spyOn(api.subjects, 'discover').mockImplementation(
      () =>
        new Promise<Subject[]>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() => expect(resolvers).toHaveLength(1))
    act(() =>
      resolvers[0]?.([eligibleSubject('sub-001'), eligibleSubject('sub-002')]),
    )
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:pass:true;sub-002:pass:true',
      ),
    )

    // The save rediscovers, and that discovery is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'exclude sub-002' }))
    await waitFor(() => expect(resolvers).toHaveLength(2))
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      /^created-project\|sub-001:pass:true\|all$/,
    )
  })

  it('reports a rediscovery in flight and stamps the time it answers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'))
      const api = installMockSupraspina()
      attachSidecar(api)
      const resolvers: Array<(subjects: Subject[]) => void> = []
      const rejecters: Array<(error: Error) => void> = []
      vi.spyOn(api.subjects, 'discover').mockImplementation(
        () =>
          new Promise<Subject[]>((resolve, reject) => {
            resolvers.push(resolve)
            rejecters.push(reject)
          }),
      )
      render(
        <AppProvider>
          <CohortSelectionProbe />
        </AppProvider>,
      )
      const progress = (): string =>
        screen.getByTestId('discovery-progress').textContent ?? ''
      fireEvent.click(screen.getByRole('button', { name: 'create A' }))
      await waitFor(() => expect(resolvers).toHaveLength(1))
      expect(progress()).toBe('true|never')
      act(() => resolvers[0]?.([eligibleSubject('sub-001')]))
      await waitFor(() =>
        expect(progress()).toBe('false|2026-10-02T10:00:00.000Z'),
      )

      vi.setSystemTime(new Date('2026-10-02T10:05:00.000Z'))
      fireEvent.click(screen.getByRole('button', { name: 'rediscover' }))
      await waitFor(() => expect(resolvers).toHaveLength(2))
      expect(progress()).toBe('true|2026-10-02T10:00:00.000Z')
      act(() => resolvers[1]?.([eligibleSubject('sub-001')]))
      await waitFor(() =>
        expect(progress()).toBe('false|2026-10-02T10:05:00.000Z'),
      )

      // A failed rediscovery ends the busy state and keeps the last stamp.
      vi.setSystemTime(new Date('2026-10-02T10:10:00.000Z'))
      fireEvent.click(screen.getByRole('button', { name: 'rediscover' }))
      await waitFor(() => expect(rejecters).toHaveLength(3))
      act(() => rejecters[2]?.(new Error('Discovery failed.')))
      await waitFor(() =>
        expect(progress()).toBe('false|2026-10-02T10:05:00.000Z'),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('discovers again when the configuration moves during discovery', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const first = eligibleSubject('sub-001')
    const second = eligibleSubject('sub-002')
    const resolvers: Array<(subjects: Subject[]) => void> = []
    vi.spyOn(api.subjects, 'discover').mockImplementation(
      () =>
        new Promise<Subject[]>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() => expect(resolvers).toHaveLength(1))
    const initial = resolvers[0]
    if (!initial) throw new Error('Provide the initial discovery.')
    act(() => initial([first]))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:pass:true',
      ),
    )

    // A discovery is in flight when an unrelated edit bumps the revision.
    fireEvent.click(screen.getByRole('button', { name: 'rediscover' }))
    await waitFor(() => expect(resolvers).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'edit config' }))
    const stale = resolvers[1]
    if (!stale) throw new Error('Provide the stale discovery.')
    act(() => stale([first, second]))

    // The stale answer is dropped and discovery is issued again; its answer
    // is the one that lands.
    await waitFor(() => expect(resolvers).toHaveLength(3))
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'sub-001:pass:true',
    )
    const fresh = resolvers[2]
    if (!fresh) throw new Error('Provide the fresh discovery.')
    act(() => fresh([second]))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-002:pass:true',
      ),
    )
  })

  /**
   * Hold every discovery until the test settles it, and open project A on a
   * sidecar that has it attached, so the open starts one discovery. Return
   * the held discoveries and a way to announce a new sidecar generation that
   * has not attached the project, which starts the attachment discovery.
   */
  async function openWithHeldDiscoveries(): Promise<{
    pending: Array<{
      resolve: (subjects: Subject[]) => void
      reject: (error: Error) => void
    }>
    detachSidecar: () => void
  }> {
    const api = installMockSupraspina()
    const attached: HostState = {
      mode: 'electron',
      platform: 'linux',
      captionMode: 'custom',
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
        capabilities: [],
        runtimeId: 'runtime-1',
        projectAttached: true,
        retryable: false,
        detail: null,
      },
    }
    let currentHost = attached
    let hostListener: ((state: HostState) => void) | null = null
    vi.spyOn(api.host, 'getState').mockImplementation(async () => currentHost)
    vi.spyOn(api.host, 'onState').mockImplementation((listener) => {
      hostListener = listener
      return () => {
        hostListener = null
      }
    })
    const pending: Array<{
      resolve: (subjects: Subject[]) => void
      reject: (error: Error) => void
    }> = []
    vi.spyOn(api.subjects, 'discover').mockImplementation(
      () =>
        new Promise<Subject[]>((resolve, reject) => {
          pending.push({ resolve, reject })
        }),
    )
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(screen.getByTestId('discovery-answered')).toHaveTextContent('false')
    return {
      pending,
      detachSidecar: () => {
        currentHost = {
          ...attached,
          sidecar: {
            ...attached.sidecar,
            generation: 2,
            runtimeId: 'runtime-2',
            projectAttached: false,
          },
        }
        act(() => hostListener?.(currentHost))
      },
    }
  }

  it('discovers again when the configuration moves while the first discovery fails', async () => {
    const { pending } = await openWithHeldDiscoveries()
    // An edit that leaves the discovery inputs alone bumps the revision
    // while the project's first discovery runs, and then that discovery
    // fails.
    fireEvent.click(screen.getByRole('button', { name: 'edit config' }))
    act(() => pending[0]?.reject(new Error('Retry discovery.')))

    // The failure is not dropped with the cohort still loading: discovery is
    // issued again with the current configuration, and its answer ends the
    // load.
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(screen.getByTestId('discovery-answered')).toHaveTextContent('false')
    act(() => pending[1]?.resolve([eligibleSubject('sub-001')]))
    await waitFor(() =>
      expect(screen.getByTestId('discovery-answered')).toHaveTextContent(
        'true',
      ),
    )
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'sub-001:pass:true',
    )
  })

  it('discovers again when the configuration moves before the attachment discovery answers', async () => {
    const { pending, detachSidecar } = await openWithHeldDiscoveries()
    // A restarted sidecar starts the attachment discovery, which supersedes
    // the first one; then an edit bumps the revision.
    detachSidecar()
    await waitFor(() => expect(pending).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'edit config' }))
    const first = eligibleSubject('sub-001')
    act(() => {
      pending[0]?.resolve([first])
      pending[1]?.resolve([first])
    })

    // Both answers are stale, the first by its token and the attachment's by
    // the revision. Discovery is issued again instead of both being dropped
    // with the cohort still loading.
    await waitFor(() => expect(pending).toHaveLength(3))
    expect(screen.getByTestId('discovery-answered')).toHaveTextContent('false')
    act(() => pending[2]?.resolve([first]))
    await waitFor(() =>
      expect(screen.getByTestId('discovery-answered')).toHaveTextContent(
        'true',
      ),
    )
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'sub-001:pass:true',
    )
  })

  it('ignores a subject refresh after the project epoch changes', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const first = eligibleSubject('sub-001')
    const second = eligibleSubject('sub-002')
    vi.spyOn(api.subjects, 'discover').mockImplementation(
      async ({ project }) =>
        project.projectId === 'project-b' ? [second] : [first],
    )
    let resolveRefresh!: (subject: Subject) => void
    vi.spyOn(api.subjects, 'refreshOne').mockImplementation(
      () =>
        new Promise<Subject>((resolve) => {
          resolveRefresh = resolve
        }),
    )
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'created-project|sub-001:pass:true',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'new' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent('none||all'),
    )
    fireEvent.click(screen.getByRole('button', { name: 'create B' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'project-b|sub-002:pass:true',
      ),
    )

    act(() => resolveRefresh({ ...first, qc: 'fail', analysisEligible: false }))
    await act(async () => undefined)
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'project-b|sub-002:pass:true',
    )
  })

  it('rejects a row refresh whose response has a different subject id', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const first = eligibleSubject('sub-001')
    vi.spyOn(api.subjects, 'discover').mockResolvedValue([first])
    vi.spyOn(api.subjects, 'refreshOne').mockResolvedValue({
      ...eligibleSubject('sub-002'),
      qc: 'fail',
      analysisEligible: false,
    })
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:pass:true',
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    await act(async () => undefined)
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'sub-001:pass:true',
    )
    expect(screen.getByTestId('cohort-state')).not.toHaveTextContent('sub-002')
  })

  it('lets a newer full discovery supersede an in-flight row refresh', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const first = eligibleSubject('sub-001')
    let resolveDiscovery!: (subjects: Subject[]) => void
    let deferDiscovery = false
    vi.spyOn(api.subjects, 'discover').mockImplementation(() => {
      if (!deferDiscovery) return Promise.resolve([first])
      return new Promise<Subject[]>((resolve) => {
        resolveDiscovery = resolve
      })
    })
    let resolveRefresh!: (subject: Subject) => void
    vi.spyOn(api.subjects, 'refreshOne').mockImplementation(
      () =>
        new Promise<Subject>((resolve) => {
          resolveRefresh = resolve
        }),
    )
    render(
      <AppProvider>
        <CohortSelectionProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'create A' }))
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:pass:true',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    deferDiscovery = true
    fireEvent.click(screen.getByRole('button', { name: 'rediscover' }))
    act(() => resolveRefresh({ ...first, qc: 'fail', analysisEligible: false }))
    await act(async () => undefined)
    expect(screen.getByTestId('cohort-state')).toHaveTextContent(
      'sub-001:pass:true',
    )

    act(() =>
      resolveDiscovery([{ ...first, qc: 'defer', analysisEligible: true }]),
    )
    await waitFor(() =>
      expect(screen.getByTestId('cohort-state')).toHaveTextContent(
        'sub-001:defer:true',
      ),
    )
  })
})

describe('AppProvider QC writes', () => {
  it('updates QC fields and eligibility from the write as the sidecar does', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const available: Subject = {
      ...eligibleSubject('sub-001'),
      t1Availability: 'available',
      qcRevision: 1,
    }
    const missing: Subject = {
      ...eligibleSubject('sub-002'),
      qc: null,
      t1Availability: 'missing',
      analysisEligible: false,
      qcRevision: 0,
    }
    // Rows without T1 availability come from mocks; the sidecar sends it.
    const unreported: Subject = {
      ...eligibleSubject('sub-003'),
      qc: 'fail',
      analysisEligible: false,
      qcRevision: 1,
    }
    vi.spyOn(api.subjects, 'discover').mockResolvedValue([
      available,
      missing,
      unreported,
    ])
    const refreshOne = vi.spyOn(api.subjects, 'refreshOne')
    render(
      <AppProvider>
        <QcWriteProbe
          writes={{
            'fail 1': qcWrite('sub-001', 'fail', 2, true, 'Motion'),
            'pass 1 without evidence': qcWrite('sub-001', 'pass', 3, false),
            'older defer 1': qcWrite('sub-001', 'defer', 1),
            'pass 2': qcWrite('sub-002', 'pass', 1),
            'pass 3': qcWrite('sub-003', 'pass', 2),
          }}
        />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'create' }))
    const rows = screen.getByTestId('qc-rows')
    await waitFor(() => expect(rows).toHaveTextContent('sub-001:pass:'))

    fireEvent.click(screen.getByRole('button', { name: 'fail 1' }))
    expect(rows).toHaveTextContent('sub-001:fail:fail:true:false:Motion:2;')
    fireEvent.click(
      screen.getByRole('button', { name: 'pass 1 without evidence' }),
    )
    expect(rows).toHaveTextContent('sub-001:unreviewed:pass:false:true::3;')
    fireEvent.click(screen.getByRole('button', { name: 'older defer 1' }))
    expect(rows).toHaveTextContent('sub-001:unreviewed:pass:false:true::3;')
    fireEvent.click(
      screen.getByRole('button', { name: 'write for another project' }),
    )
    expect(rows).toHaveTextContent('sub-001:unreviewed:pass:false:true::3;')

    fireEvent.click(screen.getByRole('button', { name: 'pass 2' }))
    expect(rows).toHaveTextContent('sub-002:pass:pass:true:false::1;')
    fireEvent.click(screen.getByRole('button', { name: 'pass 3' }))
    expect(rows).toHaveTextContent('sub-003:pass:pass:true:true::2')
    expect(refreshOne).not.toHaveBeenCalled()
  })

  it('keeps a QC write over a subject refresh that started before it', async () => {
    // Every step waits on an explicit sync point, not on a polling timeout:
    // under load the first discovery can take longer than waitFor's one
    // second, and a single microtask flush could check the stale refresh
    // before it had landed.
    const api = installMockSupraspina()
    attachSidecar(api)
    const first: Subject = {
      ...eligibleSubject('sub-001'),
      t1Availability: 'available',
      notes: '',
      qcRevision: 1,
    }
    // The discovery's answer, once the provider has asked for it.
    let answer: Promise<Subject[]> | null = null
    let discoveryStarted: () => void = () => undefined
    const discovering = new Promise<void>((resolve) => {
      discoveryStarted = resolve
    })
    const discover = vi
      .spyOn(api.subjects, 'discover')
      .mockImplementation(() => {
        answer = Promise.resolve([first])
        discoveryStarted()
        return answer
      })
    const resolvers: Array<(subject: Subject) => void> = []
    vi.spyOn(api.subjects, 'refreshOne').mockImplementation(
      () =>
        new Promise<Subject>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    render(
      <AppProvider>
        <QcWriteProbe
          writes={{ 'fail 1': qcWrite('sub-001', 'fail', 2, true, 'Motion') }}
        />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'create' }))
    const rows = screen.getByTestId('qc-rows')
    await act(async () => {
      await discovering
      await answer
      await settle()
    })
    expect(rows).toHaveTextContent('sub-001:pass:')

    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'fail 1' }))
    const written = 'sub-001:fail:fail:true:false:Motion:2'
    expect(rows).toHaveTextContent(written)

    // The refresh read the record from before the write.
    const beforeWrite = resolvers[0]
    if (!beforeWrite) throw new Error('Provide the pending refresh.')
    await act(async () => {
      beforeWrite(first)
      await settle()
    })
    expect(rows).toHaveTextContent(written)

    // A refresh started after the write still lands.
    fireEvent.click(screen.getByRole('button', { name: 'refresh 1' }))
    const afterWrite = resolvers[1]
    if (!afterWrite) throw new Error('Provide the second refresh.')
    await act(async () => {
      afterWrite({
        ...first,
        qc: 'fail',
        recordedQcVerdict: 'fail',
        qcReviewEvidencePresent: true,
        analysisEligible: false,
        notes: 'Motion, checked again',
        qcRevision: 3,
      })
      await settle()
    })
    expect(rows).toHaveTextContent(
      'sub-001:fail:fail:true:false:Motion, checked again:3',
    )
    // No other discovery answered between the steps.
    expect(discover).toHaveBeenCalledTimes(1)
  })
})

describe('AppProvider save and discard serialization', () => {
  it('saves Allow live runs with the exact revision and restores it on discard', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    const save = vi.spyOn(api.project, 'save')
    render(
      <AppProvider>
        <SaveDiscardProbe />
      </AppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'create' }))
    fireEvent.click(screen.getByRole('button', { name: 'toggle safe' }))
    expect(screen.getByTestId('safe-state')).toHaveTextContent('true')
    expect(screen.getByTestId('save-state')).toHaveTextContent('|1|0|true')
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ configRevision: 1, safeExecution: true }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('save-state')).toHaveTextContent('|1|1|false'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'toggle safe' }))
    expect(screen.getByTestId('safe-state')).toHaveTextContent('false')
    fireEvent.click(screen.getByRole('button', { name: 'discard' }))
    await waitFor(() =>
      expect(screen.getByTestId('safe-state')).toHaveTextContent('true'),
    )
    expect(screen.getByTestId('save-state')).toHaveTextContent('|1|1|false')
  })

  it('waits for an in-flight save before restoring its persisted revision', async () => {
    const api = installMockSupraspina()
    attachSidecar(api)
    let resolveSave!: (result: ProjectSaveResult) => void
    const pendingSave = new Promise<ProjectSaveResult>((resolve) => {
      resolveSave = resolve
    })
    const save = vi
      .spyOn(api.project, 'save')
      .mockImplementation(() => pendingSave)
    render(
      <AppProvider>
        <SaveDiscardProbe />
      </AppProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'create' }))
    fireEvent.click(screen.getByRole('button', { name: 'edit saved draft' }))
    fireEvent.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(save).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole('button', { name: 'edit later' }))
    fireEvent.click(screen.getByRole('button', { name: 'discard' }))
    expect(screen.getByTestId('save-state')).toHaveTextContent(
      'Later edit|2|0|true',
    )

    const request = save.mock.calls[0]?.[0]
    if (!request) throw new Error('Capture the save request.')
    act(() => {
      resolveSave({
        project: request.project,
        configRevision: request.configRevision,
        sha256: '1'.repeat(64),
      })
    })

    await waitFor(() =>
      expect(screen.getByTestId('save-state')).toHaveTextContent(
        'Saved draft|1|1|false',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'edit later' }))
    expect(screen.getByTestId('save-state')).toHaveTextContent(
      'Later edit|2|1|true',
    )
  })
})

describe('AppProvider gate-unlock lands the wizard on Review', () => {
  it('lands the wizard on the last step with full reach on markProjectCreated', () => {
    render(
      <AppProvider>
        <GateResetProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'advance' }))
    expect(screen.getByTestId('wiz')).toHaveTextContent('3:4:false')

    // Verify that a completed project unlocks the shell and returns Setup to Review
    // with every step reachable.
    fireEvent.click(screen.getByRole('button', { name: 'create' }))
    expect(screen.getByTestId('wiz')).toHaveTextContent('4:4:true')
  })

  it('lands the wizard on the last step with full reach on openProject', async () => {
    render(
      <AppProvider>
        <GateResetProbe />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'advance' }))
    expect(screen.getByTestId('wiz')).toHaveTextContent('3:4:false')

    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    await waitFor(() =>
      expect(screen.getByTestId('wiz')).toHaveTextContent('4:4:true'),
    )
  })
})

describe('AppProvider QC backend tool status', () => {
  it('reports the selected ENIGMA backend and clears it on project close', async () => {
    attachSidecar(installMockSupraspina())
    render(
      <AppProvider>
        <QcBackendProbe />
      </AppProvider>,
    )

    expect(screen.getByTestId('qc').textContent).toBe('none')
    fireEvent.click(screen.getByRole('button', { name: 'create' }))
    await waitFor(() => expect(screen.getByTestId('qc').textContent).toBe('ok'))

    // Selecting the unavailable backend must not inherit the available one.
    fireEvent.click(screen.getByRole('button', { name: 'select-mcr' }))
    await waitFor(() =>
      expect(screen.getByTestId('qc').textContent).toBe('missing'),
    )
  })
})
