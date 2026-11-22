// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { AppProvider, useApp } from '../state/context'
import { getApi } from '../state/api'
import { SetupWizard, type SetupWizardProps } from './SetupWizard'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import type { ProjectConfig } from '../../shared/project-schema'
import type { EnvReport } from '../../shared/types'
import { THEMES } from '../theme/tokens'
import { recentSubjectStepLabelLines } from '../ui'
import { MATRIX_STEPS } from '../../shared/steps'
import type {
  EnvInstallState,
  ProjectOpenResult,
  ProvisionProgress,
} from '../../shared/contract'

const PROJECT_REF = {
  projectId: 'setup-project',
  root: '/data/projects/setup-study',
  configPath: '/data/projects/setup-study/supraspina.project.json',
  epoch: 1,
}

const CONCRETE_CFG: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
  project: { ...DEFAULT_PROJECT_CONFIG.project, name: 'setup-study' },
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: PROJECT_REF.root,
    rawdataDir: `${PROJECT_REF.root}/rawdata`,
    derivativesDir: `${PROJECT_REF.root}/derivatives`,
    outputDir: `${PROJECT_REF.root}/outputs/run`,
    metadataDir: `${PROJECT_REF.root}/metadata`,
    clinicalMetadataFile: `${PROJECT_REF.root}/metadata/clinical.csv`,
    ageMetadataFile: `${PROJECT_REF.root}/metadata/age.csv`,
    qcOutputDir: `${PROJECT_REF.root}/outputs/run/qc_review`,
  },
  outputs: {
    rootDir: `${PROJECT_REF.root}/outputs/run`,
    runDir: `${PROJECT_REF.root}/outputs/run`,
    manifestPath: `${PROJECT_REF.root}/outputs/run/manifest.json`,
  },
}

function projectResult(cfg: ProjectConfig = CONCRETE_CFG): ProjectOpenResult {
  return {
    project: PROJECT_REF,
    cfg,
    configSha256: '0'.repeat(64),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** Build one installation snapshot for the project this harness renders. */
function installState(
  checkId: string,
  patch: Partial<EnvInstallState> = {},
): EnvInstallState {
  return {
    operationId: 'install-0123456789ab',
    checkId,
    projectId: PROJECT_REF.projectId,
    projectEpoch: PROJECT_REF.epoch,
    phase: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    output: '',
    rc: null,
    stdout: '',
    stderr: '',
    ...patch,
  }
}

/**
 * Drive the sidecar side of one installation: start returns an operation
 * identity, and the test publishes the phases the sidecar would report.
 */
function mockInstall(): {
  start: ReturnType<typeof vi.spyOn>
  publish: (state: EnvInstallState) => void
} {
  const api = getApi()
  const listeners = new Set<(ev: EnvInstallState) => void>()
  vi.spyOn(api.env, 'onInstallProgress').mockImplementation((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  const start = vi
    .spyOn(api.env, 'optInInstall')
    .mockResolvedValue({ operationId: 'install-0123456789ab' })
  return {
    start,
    publish: (state) => {
      act(() => {
        for (const listener of [...listeners]) listener(state)
      })
    },
  }
}

function renderWizard(): ReturnType<typeof render> {
  return render(
    <AppProvider>
      <SetupWizard />
    </AppProvider>,
  )
}

function renderWizardAt(opts: {
  step: number
  maxReached?: number
  cfg?: ProjectConfig
  wizardProps?: Omit<SetupWizardProps, 'cfg'>
}): void {
  function Opener(): ReactNode {
    const { setWizardStep, setWizardMaxReached } = useApp()
    const [show, setShow] = useState(false)
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setWizardStep(opts.step)
            if (opts.maxReached !== undefined)
              setWizardMaxReached(opts.maxReached)
            setShow(true)
          }}
        >
          mount-wizard
        </button>
        {show && (
          <SetupWizard
            {...opts.wizardProps}
            {...(opts.cfg ? { cfg: opts.cfg } : {})}
          />
        )}
      </>
    )
  }
  render(
    <AppProvider>
      <Opener />
    </AppProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'mount-wizard' }))
}

function renderLoadedWizardAt(opts: {
  step: number
  cfg?: ProjectConfig
  safeExecution?: boolean
  /** Persist the toggled Allow live runs so the saved-config gate opens. */
  saved?: boolean
  wizardProps?: Omit<SetupWizardProps, 'cfg'>
}): void {
  const cfg = opts.cfg ?? CONCRETE_CFG

  function RouteProbe(): ReactNode {
    const { route, dirty } = useApp()
    return (
      <output data-testid="route-probe">
        {`${route}:${dirty ? 'dirty' : 'clean'}`}
      </output>
    )
  }

  function Opener(): ReactNode {
    const {
      markProjectCreated,
      projectEpoch,
      saveProject,
      setSafeExecution,
      setWizardStep,
      setWizardMaxReached,
    } = useApp()
    const [show, setShow] = useState(false)
    return (
      <>
        <button
          type="button"
          onClick={() => {
            const result = projectResult(cfg)
            markProjectCreated({
              ...result,
              project: { ...result.project, epoch: projectEpoch },
            })
            if (opts.safeExecution) setSafeExecution(true)
            if (opts.saved) void saveProject()
            setWizardMaxReached(4)
            setWizardStep(opts.step)
            setShow(true)
          }}
        >
          mount-loaded-wizard
        </button>
        <RouteProbe />
        {show && <SetupWizard {...opts.wizardProps} cfg={cfg} />}
      </>
    )
  }

  render(
    <AppProvider>
      <Opener />
    </AppProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'mount-loaded-wizard' }))
}

const MIXED_ENV_REPORT: EnvReport = {
  capturedAt: 'not-a-date',
  availableMemoryGB: 8,
  groups: [
    {
      name: 'Core tools',
      checks: [
        {
          id: 'reconall',
          label: 'FreeSurfer recon-all',
          status: 'missing',
          detail: 'not found',
          recommendedCmd: 'install-recon',
          downloadUrl: 'https://surfer.nmr.mgh.harvard.edu/',
        },
        {
          id: 'rscript',
          label: 'Rscript',
          status: 'wrong',
          detail: 'unsupported version',
        },
        {
          id: 'memory',
          label: 'Available memory',
          status: 'warn',
          detail: '8 GB',
        },
        {
          id: 'bash',
          label: 'bash',
          status: 'found',
        },
      ],
    },
  ],
}

const GREEN_ENV_REPORT: EnvReport = {
  capturedAt: '2020-01-02T03:04:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'Core tools',
      checks: [
        { id: 'reconall', label: 'FreeSurfer recon-all', status: 'found' },
        { id: 'rscript', label: 'Rscript', status: 'found' },
      ],
    },
  ],
}

// Mirror the sidecar's typed PyBrainAge environment row: no command, no
// installer, only the typed setup action.
const PYBRAINAGE_SETUP_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'Python / conda',
      checks: [
        {
          id: 'pyenv',
          label: 'PyBrainAge environment',
          status: 'missing',
          detail:
            'Set up PyBrainAge to create the locked environment and record its provenance.',
          action: { kind: 'setup-pybrainage', label: 'Set up PyBrainAge' },
        },
      ],
    },
  ],
}

describe('SetupWizard', () => {
  it('should render the first step when mounted', () => {
    renderWizard()
    expect(screen.getByText('Step 1 of 5')).toBeTruthy()
    expect(screen.getByLabelText('Project name')).toBeTruthy()
  })

  it('should show a stable, focusable header title across steps', () => {
    renderWizard()
    const heading = screen.getByRole('heading', { name: 'Set up your project' })
    expect(heading.getAttribute('tabindex')).toBe('-1')

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Step 2 of 5')).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'Set up your project' }),
    ).toBeTruthy()
  })

  it('keeps a saved project clean when a step commits unchanged values', () => {
    const onCfgChange = vi.fn()
    renderLoadedWizardAt({ step: 0, wizardProps: { onCfgChange } })
    fireEvent.click(screen.getByRole('button', { name: 'Step 2: Data' }))
    expect(screen.getByText('Step 2 of 5')).toBeTruthy()
    expect(onCfgChange).not.toHaveBeenCalled()
  })

  it('states the research-use limit in one line on the Project step', () => {
    renderWizard()
    expect(
      screen.getByText(
        'For research use only; not for diagnosis or clinical decisions.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText('What Supraspina does')).toBeNull()
    // The stepper shows the position; the count stays for screen readers.
    expect(screen.getByText('Step 1 of 5')).toHaveStyle({
      position: 'absolute',
      width: '1px',
      height: '1px',
    })
  })

  it('should explain the disabled Next button with a reason tooltip', () => {
    renderWizard()
    const next = screen.getByRole('button', { name: 'Next' })
    expect((next as HTMLButtonElement).disabled).toBe(true)
    expect(next.getAttribute('title')).toBe('Enter a project name to continue.')

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'example-study' },
    })
    expect(next.getAttribute('title')).toBe(
      'Choose a project root directory to continue.',
    )

    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/example-study' },
    })
    expect((next as HTMLButtonElement).disabled).toBe(false)
    expect(next.getAttribute('title')).toBeNull()
  })

  it('keeps Next blocked for a non-absolute (tilde) project root', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'example-study' },
    })
    const next = screen.getByRole('button', { name: 'Next' })

    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '~/example' },
    })
    expect((next as HTMLButtonElement).disabled).toBe(true)
    expect(next.getAttribute('title')).toBe(
      'Fix the project root path to continue.',
    )
    // The field error owns the only statement of the absolute-path rule.
    expect(
      screen.getAllByText(
        /Enter an absolute path\. Use Browse or type the full path instead of ~/,
      ),
    ).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/example-study' },
    })
    expect((next as HTMLButtonElement).disabled).toBe(false)
  })

  it('yields the Next tooltip to the visible footer alert after a rejected Enter', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'example-study' },
    })
    const rootInput = screen.getByLabelText('Project root directory')
    fireEvent.change(rootInput, { target: { value: '~/example' } })
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next.getAttribute('title')).toBe(
      'Fix the project root path to continue.',
    )

    fireEvent.keyDown(rootInput, { key: 'Enter' })

    expect(
      screen.getByText('Fix the project root path to continue.'),
    ).toBeInTheDocument()
    expect(next.getAttribute('title')).toBeNull()
  })

  it('should disable native Browse in browser mock mode', () => {
    renderWizard()
    expect(screen.getByRole('button', { name: 'Browse...' })).toBeDisabled()
  })

  it('carries no open/recent panel (the toolbar Open menu owns that surface)', () => {
    renderWizard()
    expect(
      screen.queryByText('Open an existing project'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open saved project' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Recent projects')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Browse...' }),
    ).toBeInTheDocument()
  })

  it('should disable Next until the welcome step is valid', () => {
    renderWizard()
    const next = screen.getByRole('button', { name: 'Next' })
    expect((next as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'example-study' },
    })
    expect((next as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/example-study' },
    })
    expect((next as HTMLButtonElement).disabled).toBe(false)
  })

  it('announces an invalid Enter attempt and focuses the first invalid field', () => {
    renderWizard()
    const projectName = screen.getByLabelText('Project name')
    const projectRoot = screen.getByLabelText('Project root directory')

    projectRoot.focus()
    fireEvent.keyDown(projectRoot, { key: 'Enter' })

    // The step alert leads; each empty field also names its own fix.
    expect(
      screen.getAllByRole('alert').map((alert) => alert.textContent),
    ).toEqual(
      expect.arrayContaining([
        'Enter a project name.',
        'Enter a project name to continue.',
      ]),
    )
    expect(document.activeElement).toBe(projectName)
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument()
  })

  it('opens a fresh form without error marks on its required fields', () => {
    renderWizard()

    expect(screen.getByLabelText('Project name')).not.toBeInvalid()
    expect(screen.getByLabelText('Project root directory')).not.toBeInvalid()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('marks an empty required field once the user leaves it', () => {
    renderWizard()
    const projectName = screen.getByLabelText('Project name')
    const projectRoot = screen.getByLabelText('Project root directory')

    fireEvent.blur(projectName)
    expect(projectName).toBeInvalid()
    expect(projectName).toHaveAccessibleErrorMessage('Enter a project name.')
    expect(projectRoot).not.toBeInvalid()

    // Moving from the path input to its Browse action stays in the field.
    fireEvent.blur(projectRoot, {
      relatedTarget: screen.getByRole('button', { name: 'Browse...' }),
    })
    expect(projectRoot).not.toBeInvalid()
    fireEvent.blur(projectRoot)
    expect(projectRoot).toBeInvalid()
    expect(projectRoot).toHaveAccessibleErrorMessage(
      'Enter the project root directory.',
    )

    fireEvent.change(projectName, { target: { value: 'example-study' } })
    expect(projectName).not.toBeInvalid()
  })

  it('marks a typed project root that is not absolute at once', () => {
    renderWizard()
    const projectRoot = screen.getByLabelText('Project root directory')

    fireEvent.change(projectRoot, { target: { value: '~/example' } })
    expect(projectRoot).toBeInvalid()
  })

  it('marks every empty required field after an attempt to continue', () => {
    renderWizard()
    const projectName = screen.getByLabelText('Project name')
    const projectRoot = screen.getByLabelText('Project root directory')

    fireEvent.keyDown(projectRoot, { key: 'Enter' })
    expect(projectName).toBeInvalid()
    expect(projectRoot).toBeInvalid()
    expect(document.activeElement).toBe(projectName)

    // The next step opens clean: the attempt belonged to the first step.
    fireEvent.change(projectName, { target: { value: 'example-study' } })
    fireEvent.change(projectRoot, {
      target: { value: '/data/projects/example-study' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    const inputData = screen.getByLabelText('Input data folder')
    fireEvent.change(inputData, { target: { value: '' } })
    expect(inputData).not.toBeInvalid()
    fireEvent.keyDown(inputData, { key: 'Enter' })
    expect(inputData).toBeInvalid()
    expect(document.activeElement).toBe(inputData)
  })

  it('should preserve entered values when going Back', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Step 2 of 5')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Step 1 of 5')).toBeTruthy()
    expect(
      (screen.getByLabelText('Project name') as HTMLInputElement).value,
    ).toBe('cohort-a')
  })

  it('jumps back to a reached step via the stepper, preserving values', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Step 2 of 5')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Step 1:/ }))
    expect(screen.getByText('Step 1 of 5')).toBeTruthy()
    expect(
      (screen.getByLabelText('Project name') as HTMLInputElement).value,
    ).toBe('cohort-a')
  })

  it('disables a not-yet-reached step in the stepper', () => {
    renderWizard()
    expect(screen.getByRole('button', { name: /^Step 2:/ })).toBeDisabled()
  })

  it('advances and commits when the stepper jumps to the valid immediate-next step', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Step 2:/ }))
    expect(screen.getByText('Step 2 of 5')).toBeTruthy()
    expect(
      (screen.getByLabelText('Input data folder') as HTMLInputElement).value,
    ).toBe('/data/projects/cohort-a/rawdata')
  })

  it('refuses a forward stepper jump from an invalid step (no empty-root commit)', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Step 2 of 5')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: '' },
    })
    const stepTwo = screen.getByRole('button', { name: /^Step 2:/ })
    expect(stepTwo).toBeEnabled()

    fireEvent.click(stepTwo)
    expect(screen.getByText('Step 1 of 5')).toBeTruthy()
    // The step alert leads; each empty field also names its own fix.
    expect(
      screen.getAllByRole('alert').map((alert) => alert.textContent),
    ).toEqual(
      expect.arrayContaining([
        'Enter a project name.',
        'Enter a project name to continue.',
      ]),
    )
    expect(document.activeElement).toBe(screen.getByLabelText('Project name'))
    expect(
      (screen.getByLabelText('Project root directory') as HTMLInputElement)
        .value,
    ).toBe('/data/projects/cohort-a')
  })

  it('keeps already-reached steps reachable when mounted at a preserved step', async () => {
    renderWizardAt({ step: 2, maxReached: 4 })
    await screen.findByText('Step 3 of 5')
    expect(screen.getByRole('button', { name: /^Step 5:/ })).toBeEnabled()
  })

  it('moves focus to the step heading when mounted at a preserved non-zero step', async () => {
    renderWizardAt({ step: 3 })
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Set up your project' }),
      ),
    )
  })

  it('seeds the recon thread field from the incoming config, not the default', () => {
    const cfg16: ProjectConfig = {
      ...DEFAULT_PROJECT_CONFIG,
      runtime: { ...DEFAULT_PROJECT_CONFIG.runtime, threads: 16 },
      steps: {
        ...DEFAULT_PROJECT_CONFIG.steps,
        recon: {
          enabled: DEFAULT_PROJECT_CONFIG.steps.recon?.enabled ?? true,
          params: {
            ...(DEFAULT_PROJECT_CONFIG.steps.recon?.params ?? {}),
            threads: 16,
          },
        },
      },
    }
    renderWizardAt({ step: 4, maxReached: 4, cfg: cfg16 })
    expect(
      screen.getByText(
        'The standard workflow runs with 16 CPU threads per subject.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText('Runs include every subject found by the Data step.'),
    ).toBeTruthy()
  })

  it('lands a loaded project on Review with every step jumpable and a Save action', async () => {
    const loadedCfg: ProjectConfig = {
      ...DEFAULT_PROJECT_CONFIG,
      project: { ...DEFAULT_PROJECT_CONFIG.project, name: 'loaded-study' },
      paths: {
        ...DEFAULT_PROJECT_CONFIG.paths,
        projectRoot: '/data/projects/loaded-study',
        rawdataDir: '/data/BIDS/loaded/rawdata',
      },
    }
    function Opener(): ReactNode {
      const { markProjectCreated } = useApp()
      const [show, setShow] = useState(false)
      return (
        <>
          <button
            type="button"
            onClick={() => {
              markProjectCreated({
                project: {
                  projectId: 'loaded-study',
                  root: '/data/projects/loaded-study',
                  configPath:
                    '/data/projects/loaded-study/supraspina.project.json',
                  epoch: 1,
                },
                cfg: loadedCfg,
                configSha256: '0'.repeat(64),
              })
              setShow(true)
            }}
          >
            mount-loaded
          </button>
          {show && <SetupWizard cfg={loadedCfg} />}
        </>
      )
    }
    render(
      <AppProvider>
        <Opener />
      </AppProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'mount-loaded' }))

    expect(await screen.findByText('Step 5 of 5')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Save changes/ })).toBeTruthy()
    expect(
      screen.getByText(
        'Stage choices stay as set in Pipeline and run with 6 CPU threads per subject.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Create project/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Step 1:/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Step 4:/ })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /^Step 1:/ }))
    expect(screen.getByText('Step 1 of 5')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Step 5:/ }))
    expect(screen.getByText('Step 5 of 5')).toBeTruthy()
  })

  it('reads the environment status the application already holds on Review', async () => {
    const check = vi.spyOn(getApi().env, 'check')

    renderLoadedWizardAt({ step: 4, wizardProps: { envReport: null } })
    expect(await screen.findByText('Not checked')).toBeInTheDocument()
    expect(
      screen.getByText(
        'The required tools are not checked yet; the Environment step checks them.',
      ),
    ).toBeInTheDocument()
    cleanup()

    renderLoadedWizardAt({
      step: 4,
      wizardProps: { envReport: GREEN_ENV_REPORT },
    })
    expect(await screen.findByText('Passed')).toBeInTheDocument()
    expect(
      screen.getByText('The required environment checks passed.'),
    ).toBeInTheDocument()
    expect(screen.getByTitle('Environment checks passed.')).toBeInTheDocument()
    expect(screen.queryByText(/Continue because/)).toBeNull()
    cleanup()

    renderLoadedWizardAt({
      step: 4,
      wizardProps: { envReport: MIXED_ENV_REPORT },
    })
    expect(await screen.findByText('Needs setup')).toBeInTheDocument()
    expect(
      screen.getByText(
        '2 tools are missing. Every dependent stage stays blocked until installation finishes.',
      ),
    ).toBeInTheDocument()
    expect(check).not.toHaveBeenCalled()
  })

  it('should render default paths with the entered project root', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(
      (screen.getByLabelText('Input data folder') as HTMLInputElement).value,
    ).toBe('/data/projects/cohort-a/rawdata')
  })

  it('should hide raw matching patterns behind an advanced disclosure', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByText('Supraspina search rules')).toBeTruthy()
    expect(screen.queryByLabelText('Subject folder name pattern')).toBeNull()

    const advanced = screen.getByRole('button', {
      name: 'Advanced matching rules',
    })
    // A native button disclosure: Enter and Space activate it, it reports
    // expansion and never a pressed state, and it names a region that stays
    // in the DOM while hidden.
    expect(advanced.tagName).toBe('BUTTON')
    expect(advanced).toHaveAttribute('type', 'button')
    expect(advanced).not.toHaveAttribute('tabindex')
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(advanced).not.toHaveAttribute('aria-pressed')
    const region = document.getElementById(
      advanced.getAttribute('aria-controls') ?? '',
    )
    expect(region).not.toBeNull()
    expect(region).not.toBeVisible()
    const closedLook = advanced.getAttribute('style')
    fireEvent.click(advanced)

    expect(advanced).toHaveAccessibleName('Advanced matching rules')
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    expect(advanced).not.toHaveAttribute('aria-pressed')
    // An open disclosure keeps the closed look: no pressed fill.
    expect(advanced.getAttribute('style')).toBe(closedLook)
    expect(region).toBeVisible()
    expect(region).toContainElement(
      screen.getByLabelText('Subject folder name pattern'),
    )
    expect(screen.getByLabelText('T1 file name pattern')).toBeTruthy()

    fireEvent.click(advanced)
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(region).not.toBeVisible()
    expect(screen.queryByLabelText('Subject folder name pattern')).toBeNull()
  })

  it('should validate optional subject filters against the data pattern', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    fireEvent.change(screen.getByLabelText('Subjects to run'), {
      target: { value: 'sample-001' },
    })
    expect(screen.getByText('Match sub-*.')).toBeTruthy()

    const advanced = screen.getByRole('button', {
      name: 'Advanced matching rules',
    })
    fireEvent.click(advanced)
    fireEvent.change(screen.getByLabelText('Subject folder name pattern'), {
      target: { value: 'sample-*' },
    })

    const add = screen.getByRole('button', { name: 'Add' })
    expect((add as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(add)
    expect(screen.getByText('sample-001')).toBeTruthy()
  })

  it('should keep a custom rawdata path when the project root changes', () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    fireEvent.change(screen.getByLabelText('Input data folder'), {
      target: { value: '/data/raw/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-b' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(
      (screen.getByLabelText('Input data folder') as HTMLInputElement).value,
    ).toBe('/data/raw/cohort-a')
  })

  it('should mark the active step with aria-current', () => {
    renderWizard()
    const current = document.querySelector('[aria-current="step"]')
    expect(current).not.toBeNull()
    expect(current?.textContent).toContain('Project')
  })

  it('treats pre-create environment verification as project-scoped and advisory', async () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    fireEvent.change(screen.getByLabelText('Input data folder'), {
      target: { value: '/data/BIDS/cohort-a/rawdata' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(
      await screen.findByText(
        /project-scoped checks run after this project is created/i,
      ),
    ).toBeTruthy()
    expect(screen.queryByText('R packages')).toBeNull()
    expect(
      screen.getByText(/Setup can continue without tool status/i),
    ).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    const next = screen.getByRole('button', { name: 'Next' })
    await waitFor(() =>
      expect((next as HTMLButtonElement).disabled).toBe(false),
    )
  })

  it('does not invent tool availability before the project exists', async () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByLabelText('Input data folder'), {
      target: { value: '/data/BIDS/cohort-a/rawdata' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(
      await screen.findByText(
        /project-scoped checks run after this project is created/i,
      ),
    ).toBeTruthy()
    expect(screen.queryByText(/The R packages used by/i)).toBeNull()
  })

  it('should reveal the ten standard-workflow steps on the pipeline step', async () => {
    renderWizard()
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'cohort-a' },
    })
    fireEvent.change(screen.getByLabelText('Project root directory'), {
      target: { value: '/data/projects/cohort-a' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByLabelText('Input data folder'), {
      target: { value: '/data/BIDS/cohort-a/rawdata' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(
      await screen.findByText(
        /project-scoped checks run after this project is created/i,
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByText('Step 4 of 5')).toBeTruthy()
    const disclosure = screen.getByRole('button', {
      name: 'Workflow milestones in Subjects',
    })
    expect(disclosure.tagName).toBe('BUTTON')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(disclosure).not.toHaveAttribute('aria-pressed')
    const region = document.getElementById(
      disclosure.getAttribute('aria-controls') ?? '',
    )
    expect(region).not.toBeNull()
    expect(region).not.toBeVisible()
    expect(screen.queryByLabelText('Workflow status milestones')).toBeNull()
    const closedLook = disclosure.getAttribute('style')
    fireEvent.click(disclosure)
    // The label stays constant and the open state is not a pressed toggle.
    expect(disclosure).toHaveAccessibleName('Workflow milestones in Subjects')
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(disclosure).not.toHaveAttribute('aria-pressed')
    expect(disclosure.getAttribute('style')).toBe(closedLook)
    expect(region).toBeVisible()
    const list = screen.getByLabelText('Workflow status milestones')
    expect(region).toContainElement(list)
    // Each milestone carries the name its Subjects column header shows, not
    // the matrix's short code ("QC Sub.", "Feat.", "PBA.").
    const names = within(list)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('strong')?.textContent)
    expect(names).toEqual([
      'Reconstruction. ',
      'Subcortical QC. ',
      'Internal cortical QC. ',
      'External cortical QC. ',
      'Feature extraction. ',
      'PyBrainAge. ',
      'BrainCharts. ',
      'Statistics. ',
      'Aggregation. ',
      'Report. ',
    ])
    expect(names).toEqual(
      MATRIX_STEPS.map(
        (step) => `${recentSubjectStepLabelLines(step.key).join(' ')}. `,
      ),
    )
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(region).not.toBeVisible()
  })

  it('renders a real project environment report and gates opt-in installs through confirmation', async () => {
    const api = getApi()
    let resolveReport!: (report: EnvReport) => void
    const pendingReport = new Promise<EnvReport>((resolve) => {
      resolveReport = resolve
    })
    const check = vi
      .spyOn(api.env, 'check')
      .mockReturnValueOnce(pendingReport)
      .mockResolvedValue(GREEN_ENV_REPORT)
    const authorize = vi.spyOn(api.execution, 'authorize')
    const install = mockInstall()
    const openWeb = vi.spyOn(api.external, 'openWeb')
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    )
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    try {
      renderLoadedWizardAt({ step: 2 })
      expect(
        await screen.findByText('Running the environment check...'),
      ).toBeInTheDocument()

      await act(async () => resolveReport(MIXED_ENV_REPORT))
      expect(
        await screen.findByText('Some required checks need setup.'),
      ).toBeInTheDocument()
      expect(screen.getByText(/2 tools are missing\./)).toHaveTextContent(
        '2 tools are missing. Setup can continue now; each dependent pipeline stage stays blocked until its tool is installed.',
      )
      expect(screen.getByText('Check time unknown.')).toBeInTheDocument()
      expect(screen.getByText('Core tools')).toBeInTheDocument()

      const installButton = screen.getByRole('button', {
        name: 'Install FreeSurfer recon-all',
      })
      expect(installButton).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Allow live runs' }))
      await waitFor(() => expect(installButton).toBeEnabled())

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Copy fix for FreeSurfer recon-all',
        }),
      )
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith('install-recon'),
      )
      expect(await screen.findByText('Copied')).toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Get it: open the download page for FreeSurfer recon-all',
        }),
      )
      expect(openWeb).toHaveBeenCalledWith({
        url: 'https://surfer.nmr.mgh.harvard.edu/',
        purpose: 'download',
      })

      fireEvent.click(installButton)
      expect(
        screen.getByRole('dialog', {
          name: 'Confirm installation of FreeSurfer recon-all',
        }),
      ).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('dialog')).toBeNull()

      fireEvent.click(installButton)
      fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))
      expect(
        await screen.findByText(
          'Running package installation for FreeSurfer recon-all.',
        ),
      ).toBeInTheDocument()
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ purpose: 'opt-in-install' }),
      )
      expect(install.start).toHaveBeenCalledWith(
        expect.objectContaining({ checkId: 'reconall' }),
      )

      // A failed installation stays inspectable and never triggers a reprobe.
      install.publish(
        installState('reconall', {
          phase: 'error',
          rc: 1,
          stderr: 'Retry because the installer is offline.',
        }),
      )
      expect(
        await screen.findByText(
          'The installation of FreeSurfer recon-all failed.',
        ),
      ).toBeInTheDocument()
      expect(
        screen.getByText('Retry because the installer is offline.'),
      ).toBeInTheDocument()
      expect(check).toHaveBeenCalledTimes(1)

      const groupToggle = screen.getByText('Core tools').closest('button')
      expect(groupToggle).not.toBeNull()
      fireEvent.click(groupToggle!)
      expect(
        screen.queryByRole('button', {
          name: 'Install FreeSurfer recon-all',
        }),
      ).toBeNull()
      fireEvent.click(groupToggle!)

      fireEvent.click(screen.getByRole('button', { name: 'Open Diagnostics' }))
      expect(screen.getByTestId('route-probe')).toHaveTextContent('diagnostics')

      // A successful installation reprobes without a manual re-check.
      fireEvent.click(
        screen.getByRole('button', { name: 'Install FreeSurfer recon-all' }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))
      install.publish(
        installState('reconall', {
          phase: 'done',
          rc: 0,
          stdout: 'installed',
        }),
      )
      await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
      expect(
        await screen.findByText('All required checks passed.'),
      ).toBeInTheDocument()
      // The banner states the fact once, and not as an order to continue.
      expect(screen.getAllByText(/required checks passed/)).toHaveLength(1)
      expect(screen.queryByText(/Continue because/)).toBeNull()
      expect(screen.getByTitle(GREEN_ENV_REPORT.capturedAt)).toHaveTextContent(
        /^Checked /,
      )
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      } else {
        Reflect.deleteProperty(navigator, 'clipboard')
      }
    }
  })

  it('reports a refused download link instead of leaving the control silent', async () => {
    const api = getApi()
    vi.spyOn(api.env, 'check').mockResolvedValue(MIXED_ENV_REPORT)
    vi.spyOn(api.external, 'openWeb').mockRejectedValue(
      new Error('Refuse the unreviewed destination.'),
    )
    renderLoadedWizardAt({ step: 2 })

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Get it: open the download page for FreeSurfer recon-all',
      }),
    )

    expect(
      await screen.findByText(
        'Open this download link manually; Supraspina refused it.',
      ),
    ).toBeInTheDocument()
  })

  it('routes the typed PyBrainAge row action through the shared setup flow and reprobes', async () => {
    const api = getApi()
    const verifiedPython = `${PROJECT_REF.root}/outputs/run/.pybrainage/current/envs/pybrainage/bin/python`
    const verifiedModel = `${PROJECT_REF.root}/outputs/run/.pybrainage/current/pybrainage/v3/software/ExtraTreesModel`
    const verifiedScaler = `${PROJECT_REF.root}/outputs/run/.pybrainage/current/pybrainage/v3/software/scaler.pkl`
    const check = vi
      .spyOn(api.env, 'check')
      .mockResolvedValueOnce(PYBRAINAGE_SETUP_REPORT)
      .mockResolvedValueOnce(GREEN_ENV_REPORT)
    const authorize = vi.spyOn(api.execution, 'authorize')
    let progress: ((event: ProvisionProgress) => void) | null = null
    const off = vi.fn()
    vi.spyOn(api.provision, 'onProgress').mockImplementation((callback) => {
      progress = callback
      return off
    })
    const provision = vi
      .spyOn(api.provision, 'pybrainage')
      .mockResolvedValue({ operationId: 'provision-wizard' })
    const status = vi.spyOn(api.provision, 'status').mockResolvedValue({
      envReady: true,
      modelReady: true,
      pythonExecutable: verifiedPython,
      modelPath: verifiedModel,
      scalerPath: verifiedScaler,
      projectId: PROJECT_REF.projectId,
      projectEpoch: PROJECT_REF.epoch,
      // The safe-execution save leaves the project at saved revision 1.
      configRevision: 1,
      operationId: 'provision-wizard',
      phase: 'done',
      cancellable: false,
      error: null,
    })

    renderLoadedWizardAt({ step: 2, safeExecution: true, saved: true })
    // Wait for the persisted Allow live runs so the saved-config gate opens.
    await waitFor(() =>
      expect(screen.getByTestId('route-probe')).toHaveTextContent(
        'wizard:clean',
      ),
    )

    const action = await screen.findByRole('button', {
      name: 'Set up PyBrainAge for PyBrainAge environment',
    })
    expect(document.body.textContent).not.toContain('provision.pybrainage')
    expect(
      screen.queryByRole('button', {
        name: 'Copy fix for PyBrainAge environment',
      }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: 'Install PyBrainAge environment',
      }),
    ).toBeNull()

    fireEvent.click(action)
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm PyBrainAge setup',
    })
    // The dialog states what setup does as facts, not as orders.
    expect(dialog).toHaveTextContent(
      'Setup requires Allow live runs. It creates or updates the pinned micromamba environment',
    )
    expect(dialog).toHaveTextContent(
      'If you cancel setup, Supraspina requests cancellation immediately',
    )
    expect(dialog).toHaveTextContent(
      'After setup succeeds, Supraspina applies the exact verified Python, model, and scaler paths as unsaved project changes. Save the project to keep them.',
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Authorize setup' }),
    )
    await waitFor(() => expect(provision).toHaveBeenCalledOnce())
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'provision' }),
    )

    await act(async () => {
      progress?.({
        phase: 'done',
        percent: 100,
        message: 'Setup complete.',
        projectId: PROJECT_REF.projectId,
        projectEpoch: PROJECT_REF.epoch,
        operationId: 'provision-wizard',
      })
    })
    await waitFor(() => expect(status).toHaveBeenCalledOnce())
    // The verified paths land in the live draft, and the reprobe sends them.
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
    const lastCheck = check.mock.calls.at(-1)?.[0] as {
      cfg: ProjectConfig
    }
    expect(
      String(lastCheck.cfg.steps.pybrainage.params['pythonExecutable']),
    ).toBe(verifiedPython)
    expect(lastCheck.cfg.pybrain.modelPath).toBe(verifiedModel)
    expect(lastCheck.cfg.pybrain.scalerPath).toBe(verifiedScaler)
    expect(screen.getByText('All required checks passed.')).toBeInTheDocument()
  })

  it('keeps advisory checks out of the setup counts and readiness', async () => {
    // No stage gate names the R package stack, so a missing one is advisory.
    vi.spyOn(getApi().env, 'check').mockResolvedValue({
      capturedAt: '2026-01-01T00:00:00.000Z',
      availableMemoryGB: 24,
      groups: [
        {
          name: 'Core tools',
          checks: [
            { id: 'reconall', label: 'FreeSurfer recon-all', status: 'found' },
            { id: 'rpkgs', label: 'Optional R packages', status: 'missing' },
          ],
        },
      ],
    })
    renderLoadedWizardAt({ step: 2 })

    expect(
      await screen.findByText('All required checks passed.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/missing tool/)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /Core tools.*2 checks, 1 required, all found/i,
      }),
    ).toBeInTheDocument()
  })

  it('gates the typed PyBrainAge action behind Allow live runs in the wizard', async () => {
    vi.spyOn(getApi().env, 'check').mockResolvedValue(PYBRAINAGE_SETUP_REPORT)
    renderLoadedWizardAt({ step: 2 })

    const action = await screen.findByRole('button', {
      name: 'Set up PyBrainAge for PyBrainAge environment',
    })
    expect(action).toBeDisabled()
    expect(screen.getByText('Needs live runs')).toBeInTheDocument()
  })

  it('shows an environment failure and retries the same loaded project generation', async () => {
    const check = vi
      .spyOn(getApi().env, 'check')
      .mockRejectedValueOnce('runtime offline')
      .mockResolvedValueOnce(GREEN_ENV_REPORT)
    renderLoadedWizardAt({ step: 2 })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The environment check failed: runtime offline',
    )
    // The sentence is sans; the raw message sits on its own mono line.
    const raw = screen.getByText('runtime offline')
    expect(raw.style.fontFamily).toContain('WebCM Mono 10')
    expect(raw.style.display).toBe('block')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(check).toHaveBeenCalledTimes(2))
    expect(
      await screen.findByText('All required checks passed.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  })

  it('names a rejected environment check as the reason Next is disabled', async () => {
    // After env.check rejects, the disabled Next names the failure, not a check
    // that is still running.
    vi.spyOn(getApi().env, 'check').mockRejectedValueOnce('runtime offline')
    renderLoadedWizardAt({ step: 2 })
    await screen.findByText('runtime offline')

    const next = screen.getByRole('button', { name: 'Next' })
    expect(next).toBeDisabled()
    expect(next).toHaveAttribute(
      'title',
      'The environment check failed; retry it to continue.',
    )

    fireEvent.click(screen.getByRole('button', { name: /^Step 4:/ }))
    const alerts = screen.getAllByRole('alert')
    expect(alerts.map((alert) => alert.textContent)).toContain(
      'The environment check failed; retry it to continue.',
    )
    expect(
      screen.queryByText('The environment check is still running.'),
    ).toBeNull()
    expect(screen.getByText('Step 3 of 5')).toBeInTheDocument()
  })

  it('ignores a late environment result after leaving the project-scoped step', async () => {
    let resolveReport!: (report: EnvReport) => void
    vi.spyOn(getApi().env, 'check').mockReturnValueOnce(
      new Promise<EnvReport>((resolve) => {
        resolveReport = resolve
      }),
    )
    renderLoadedWizardAt({ step: 2 })
    await screen.findByText('Running the environment check...')

    fireEvent.click(screen.getByRole('button', { name: /^Step 2:/ }))
    expect(screen.getByText('Step 2 of 5')).toBeInTheDocument()
    await act(async () => resolveReport(GREEN_ENV_REPORT))

    expect(screen.queryByText('All required checks passed.')).toBeNull()
  })

  it('reads an attempt to advance during the environment check as progress, not an error', async () => {
    vi.spyOn(getApi().env, 'check').mockReturnValueOnce(
      new Promise<EnvReport>(() => undefined),
    )
    renderLoadedWizardAt({ step: 2 })
    await screen.findByText('Running the environment check...')

    fireEvent.click(screen.getByRole('button', { name: /^Step 4:/ }))

    const message = screen.getByText('The environment check is still running.')
    expect(message).toHaveAttribute('role', 'status')
    expect(message).toHaveStyle({ color: THEMES.light.dim })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Step 3 of 5')).toBeInTheDocument()
  })

  it('reuses a current environment report the application holds instead of rerunning the check', async () => {
    const check = vi
      .spyOn(getApi().env, 'check')
      .mockResolvedValue(GREEN_ENV_REPORT)
    renderLoadedWizardAt({
      step: 2,
      wizardProps: { envReport: MIXED_ENV_REPORT },
    })

    expect(
      await screen.findByText('Some required checks need setup.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Running the environment check...')).toBeNull()
    expect(check).not.toHaveBeenCalled()

    // A manual recheck still runs a fresh check.
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => expect(check).toHaveBeenCalledOnce())
    expect(
      await screen.findByText('All required checks passed.'),
    ).toBeInTheDocument()
  })

  it('validates processing power and commits a low-core recommendation', async () => {
    vi.spyOn(getApi().platform, 'cpuCount').mockResolvedValueOnce(3)
    renderWizardAt({ step: 3, maxReached: 4, cfg: CONCRETE_CFG })

    expect(
      await screen.findByText(
        'Recommended: 1 CPU thread per subject on this 3-thread workstation.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'New projects start with the standard workflow. Advanced step choices are set in Pipeline after setup.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Some steps split work across the left and right sides/),
    ).toBeInTheDocument()
    const threads = screen.getByLabelText('Processing power per subject')
    fireEvent.change(threads, { target: { value: '1.5' } })
    expect(
      screen.getByText('Enter an integer of 1 or more.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute(
      'title',
      'Enter an integer thread count of 1 or more.',
    )

    fireEvent.change(threads, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/1 CPU thread per subject/)).toBeInTheDocument()
  })

  it('falls back to the configured thread recommendation when CPU detection fails', async () => {
    vi.spyOn(getApi().platform, 'cpuCount').mockRejectedValueOnce(
      new Error('cpu unavailable'),
    )
    renderWizardAt({ step: 3, cfg: CONCRETE_CFG })

    expect(
      await screen.findByText('Recommended: 6 CPU threads per subject.'),
    ).toBeInTheDocument()
  })

  it('marks stale included subjects invalid after a pattern change and supports removal', () => {
    const cfg: ProjectConfig = {
      ...CONCRETE_CFG,
      subjects: { ...CONCRETE_CFG.subjects, include: ['sub-001'] },
    }
    renderWizardAt({ step: 1, maxReached: 4, cfg })
    fireEvent.click(
      screen.getByRole('button', { name: 'Advanced matching rules' }),
    )
    fireEvent.change(screen.getByLabelText('Subject folder name pattern'), {
      target: { value: 'sample-*' },
    })

    expect(
      screen.getByText(
        'Remove subjects that no longer match the subject folder pattern.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    const remove = screen.getByRole('button', { name: 'Remove sub-001' })
    expect(remove).toHaveStyle({ width: '24px', height: '24px' })
    fireEvent.click(remove)
    expect(
      screen.getByText(
        /No subjects are listed, so the run includes every match\./,
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Subjects to run'), {
      target: { value: 'sample-001' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText('Subjects to run'), {
      target: { value: 'sample-001' },
    })
    expect(screen.getByText('Already added')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  it('validates excluded subjects like included ones and refuses an ID in both lists', () => {
    const cfg: ProjectConfig = {
      ...CONCRETE_CFG,
      subjects: { ...CONCRETE_CFG.subjects, include: ['sub-001'] },
    }
    renderWizardAt({ step: 1, maxReached: 4, cfg })
    expect(screen.getByText('No subjects are excluded.')).toBeInTheDocument()
    const input = screen.getByLabelText('Subjects to exclude')
    const add = screen.getByRole('button', { name: 'Add excluded subject' })

    fireEvent.change(input, { target: { value: 'sample-002' } })
    expect(screen.getByText('Match sub-*.')).toBeInTheDocument()
    expect(add).toBeDisabled()

    fireEvent.change(input, { target: { value: 'sub-001' } })
    expect(screen.getByText('Already in Subjects to run')).toBeInTheDocument()
    expect(add).toBeDisabled()

    fireEvent.change(input, { target: { value: 'sub-002' } })
    fireEvent.click(add)
    expect(
      within(screen.getByRole('list', { name: 'Excluded subjects' })).getByText(
        'sub-002',
      ),
    ).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'sub-002' } })
    expect(screen.getByText('Already added')).toBeInTheDocument()

    // The include list refuses an excluded ID the same way.
    fireEvent.change(screen.getByLabelText('Subjects to run'), {
      target: { value: 'sub-002' },
    })
    expect(
      screen.getByText('Already in Subjects to exclude'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove sub-002 from the excluded subjects',
      }),
    )
    expect(screen.getByText('No subjects are excluded.')).toBeInTheDocument()
  })

  it('blocks Next on a stale excluded subject and states an overlap from the file', () => {
    const cfg: ProjectConfig = {
      ...CONCRETE_CFG,
      subjects: { include: ['sub-001'], exclude: ['sub-001', 'sub-003'] },
    }
    renderWizardAt({ step: 1, maxReached: 4, cfg })
    expect(
      screen.getByText(
        'sub-001 is also in Subjects to run; exclusion takes precedence, so it does not run.',
      ),
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Advanced matching rules' }),
    )
    fireEvent.change(screen.getByLabelText('Subject folder name pattern'), {
      target: { value: 'sample-*' },
    })
    expect(
      screen.getAllByText(
        'Remove subjects that no longer match the subject folder pattern.',
      ),
    ).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('creates a project with the excluded subjects and states them in Review', async () => {
    const onCreate = vi.fn(async () => projectResult())
    renderWizardAt({
      step: 1,
      maxReached: 4,
      cfg: CONCRETE_CFG,
      wizardProps: { onCreate },
    })
    fireEvent.change(screen.getByLabelText('Subjects to exclude'), {
      target: { value: 'sub-054' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add excluded subject' }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^Step 5:/ }))

    expect(
      screen.getByText(
        'Runs include every subject found by the Data step. The subject excluded in Data stays out of every run and the analysis cohort.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    expect(onCreate).toHaveBeenCalledWith(PROJECT_REF.root, {
      ...CONCRETE_CFG,
      subjects: { include: [], exclude: ['sub-054'] },
    })
  })

  it('saves an edited exclusion list with Save changes', async () => {
    const save = vi.spyOn(getApi().project, 'save')
    renderLoadedWizardAt({ step: 1 })
    fireEvent.change(screen.getByLabelText('Subjects to exclude'), {
      target: { value: 'sub-054' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add excluded subject' }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^Step 5:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0]![0].cfg.subjects).toEqual({
      include: [],
      exclude: ['sub-054'],
    })
  })

  it('keeps the include list beside a new exclusion on Save changes', async () => {
    const save = vi.spyOn(getApi().project, 'save')
    renderLoadedWizardAt({ step: 1 })
    fireEvent.change(screen.getByLabelText('Subjects to run'), {
      target: { value: 'sub-101' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    fireEvent.change(screen.getByLabelText('Subjects to exclude'), {
      target: { value: 'sub-054' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: 'Add excluded subject' }),
    )
    fireEvent.click(screen.getByRole('button', { name: /^Step 5:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(save.mock.calls[0]![0].cfg.subjects).toEqual({
      include: ['sub-101'],
      exclude: ['sub-054'],
    })
  })

  it('creates a concrete project through the supplied owner callback', async () => {
    const onCreate = vi.fn(async () => projectResult())
    const refresh = vi.fn()
    renderWizardAt({
      step: 4,
      maxReached: 4,
      cfg: CONCRETE_CFG,
      wizardProps: { onCreate, refresh },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    expect(onCreate).toHaveBeenCalledWith(PROJECT_REF.root, CONCRETE_CFG)
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  })

  it('creates from edited working values reached through Back and a Review jump', async () => {
    vi.spyOn(getApi().platform, 'cpuCount').mockResolvedValue(16)
    const onCreate = vi.fn(async () => projectResult())
    renderWizardAt({
      step: 3,
      maxReached: 4,
      cfg: CONCRETE_CFG,
      wizardProps: { onCreate },
    })

    fireEvent.change(
      await screen.findByLabelText('Processing power per subject'),
      { target: { value: '9' } },
    )
    // Back commits nothing, and the Review jump commits only the step it
    // leaves, so the edit reaches Create only through composition.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: /^Step 5:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledOnce())
    expect(onCreate).toHaveBeenCalledWith(
      PROJECT_REF.root,
      expect.objectContaining({
        runtime: expect.objectContaining({ threads: 9 }),
      }),
    )
  })

  it('uses the project API by default and strips IPC wrappers from creation failures', async () => {
    const create = vi.spyOn(getApi().project, 'create')
    renderWizardAt({ step: 4, maxReached: 4, cfg: CONCRETE_CFG })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ at: PROJECT_REF.root, epoch: 2 }),
    )

    cleanup()
    vi.restoreAllMocks()
    const onCreate = vi.fn(async () => {
      const error = new Error(
        "Error invoking remote method 'project:create': Error: destination denied",
      )
      throw error
    })
    renderWizardAt({
      step: 4,
      maxReached: 4,
      cfg: CONCRETE_CFG,
      wizardProps: { onCreate },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The project could not be created: destination denied',
    )
  })

  it('creates and adopts a project after an open failed and reserved an epoch', async () => {
    const api = getApi()
    vi.spyOn(api.project, 'open').mockRejectedValue(
      new Error('project.open: steps.recon.params.threads: is not a parameter'),
    )
    const create = vi
      .spyOn(api.project, 'create')
      .mockImplementation(async (request) => ({
        ...projectResult(CONCRETE_CFG),
        project: { ...PROJECT_REF, epoch: request.epoch },
      }))

    renderWizardAt({ step: 4, maxReached: 4, cfg: CONCRETE_CFG })
    await expect(
      getApi().project.open({
        path: PROJECT_REF.configPath,
        epoch: 5,
      }),
    ).rejects.toThrow(/is not a parameter/)

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    )
  })

  it('rejects unresolved output templates before project creation', async () => {
    const cfg: ProjectConfig = {
      ...DEFAULT_PROJECT_CONFIG,
      project: { ...DEFAULT_PROJECT_CONFIG.project, name: 'unresolved' },
      paths: {
        ...DEFAULT_PROJECT_CONFIG.paths,
        projectRoot: '/data/projects/unresolved',
        rawdataDir: '${missingRoot}/rawdata',
      },
    }
    const onCreate = vi.fn(async () => projectResult(cfg))
    renderWizardAt({
      step: 4,
      maxReached: 4,
      cfg,
      wizardProps: { onCreate },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'remove every unresolved ${...} placeholder.',
    )
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows bounded in-flight state while saving an existing project', async () => {
    const api = getApi()
    let resolveSave!: (value: {
      project: typeof PROJECT_REF
      configRevision: number
      sha256: string
    }) => void
    const save = vi.spyOn(api.project, 'save').mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve
      }),
    )
    renderLoadedWizardAt({ step: 4 })

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Saving the changes...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    await act(async () =>
      resolveSave({
        project: save.mock.calls[0]![0].project,
        configRevision: 0,
        sha256: '1'.repeat(64),
      }),
    )

    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(screen.getByTestId('route-probe')).toHaveTextContent('project')
  })

  it('surfaces a normalized loaded-project save failure', async () => {
    vi.spyOn(getApi().project, 'validate').mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'project:validate': Error: stale",
      ),
    )
    renderLoadedWizardAt({ step: 4 })

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These changes could not be saved: stale',
    )
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
  })
})
