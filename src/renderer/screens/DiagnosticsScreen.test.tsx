import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { useLayoutEffect, useRef } from 'react'
import { DiagnosticsScreen } from './DiagnosticsScreen'
import { ScientificResourcesPanel } from './ScientificResourcesPanel'
import { AppProvider, useApp } from '../state/context'
import { getApi } from '../state/api'
import { DEFAULT_PROJECT_CONFIG } from '../../shared/project-schema'
import { STEP_KEYS } from '../../shared/steps'
import { THEMES } from '../theme/tokens'
import type { EnvReport } from '../../shared/types'
import type {
  EnvInstallState,
  HostState,
  ManagedResourceProgress,
  ManagedResourceRuntime,
  ManagedResourceStatus,
  ManagedResourceStatusResult,
} from '../../shared/contract'

const DIAGNOSTICS_PROJECT = {
  projectId: 'diagnostics-project',
  root: '/projects/diagnostics',
  configPath: '/projects/diagnostics/supraspina.project.json',
  epoch: 1,
}
const DIAGNOSTICS_CONFIG = {
  ...DEFAULT_PROJECT_CONFIG,
  paths: {
    ...DEFAULT_PROJECT_CONFIG.paths,
    projectRoot: DIAGNOSTICS_PROJECT.root,
  },
}

const INSTALLABLE_REQUIRED_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'R',
      checks: [
        {
          id: 'rscript',
          label: 'Rscript',
          status: 'missing',
          recommendedCmd: 'install-rscript',
        },
      ],
    },
  ],
}

const MANUAL_REQUIRED_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'MATLAB / MATLAB Runtime',
      checks: [
        {
          id: 'mcr',
          label: 'MATLAB Runtime',
          status: 'missing',
          recommendedCmd: 'sudo ./mcr_installer/install -mode silent',
          installable: false,
        },
      ],
    },
  ],
}

const PYBRAINAGE_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'Python',
      checks: [
        {
          id: 'pyenv',
          label: 'Pinned PyBrainAge runtime',
          status: 'missing',
        },
      ],
    },
  ],
}

// Mirror the sidecar after a build that re-pinned a resource: the acquired
// generation no longer matches the revised inventory, but every file is on
// disk, so the acquisition is an offline rebuild.
const REBUILD_COMMAND =
  '/opt/Supraspina/resources/sidecar/supraspina-sidecar --acquire-scientific-assets'
const OFFLINE_REBUILD_REPORT: EnvReport = {
  capturedAt: '2026-09-23T17:05:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'Pipeline assets',
      checks: [
        {
          id: 'scientific_assets',
          label: 'Reviewed scientific assets',
          status: 'missing',
          detail:
            "Rebuild the scientific assets from the verified files already on this machine; nothing is downloaded. The acquired set no longer matches this version's reviewed inventory.",
          recommendedCmd: REBUILD_COMMAND,
          installable: true,
          offlineInstall: true,
        },
        {
          id: 'enigma_assets',
          label: 'ENIGMA QC assets',
          status: 'missing',
          detail:
            'Rebuild the scientific assets to restore the ENIGMA QC assets; 230 missing and 0 mismatched: compiled/run.sh, +229 more.',
          recommendedCmd: REBUILD_COMMAND,
          installable: true,
          offlineInstall: true,
        },
        {
          id: 'features_assets',
          label: 'Feature extraction assets',
          status: 'missing',
          detail:
            'Rebuild the scientific assets to restore 1 missing asset(s): features/rois_input_template.txt.',
        },
        {
          id: 'pipeline_assets',
          label: 'Pipeline step assets',
          status: 'missing',
          detail:
            'Rebuild the scientific assets to restore 1 missing step asset(s): features/rois_input_template.txt.',
        },
      ],
    },
  ],
}

const EMPTY_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [],
}

// Mirror the sidecar's typed PyBrainAge rows: no command, no installer, the
// Zenodo record only where it documents provenance, plus one installable row
// for install-plan coverage.
const PYBRAINAGE_ACTION_REPORT: EnvReport = {
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
        {
          id: 'modelfile',
          label: 'PyBrainAge ExtraTrees model',
          status: 'missing',
          detail:
            'Set up PyBrainAge to fetch and verify the ExtraTrees model (108 MB). Get it opens the pinned Zenodo record for provenance review.',
          downloadUrl: 'https://zenodo.org/records/10406573',
          action: { kind: 'setup-pybrainage', label: 'Set up PyBrainAge' },
        },
      ],
    },
    {
      name: 'R',
      checks: [
        {
          id: 'rscript',
          label: 'Rscript',
          status: 'missing',
          recommendedCmd: 'install-rscript',
        },
      ],
    },
  ],
}

// Mirror the sidecar's R remediation shapes: copy-only system hints on the
// rscript and pandoc rows, and a user-space command installer bound to the
// Final stage interpreter on the rmarkdown row.
const RMARKDOWN_INSTALL_CMD =
  '/opt/R/bin/Rscript -e \'install.packages(c("rmarkdown"), lib = supraspina_user_lib, repos = "https://cloud.r-project.org")\''

const R_SETUP_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'R',
      checks: [
        {
          id: 'rscript',
          label: 'Rscript',
          status: 'missing',
          detail:
            'Configure Rscript or add it to PATH. Get it opens the official R project site.',
          recommendedCmd: 'sudo apt-get install r-base',
          downloadUrl: 'https://www.r-project.org',
          installable: false,
        },
        {
          id: 'rmarkdown',
          label: 'R Markdown',
          status: 'missing',
          detail: 'Install rmarkdown for /opt/R/bin/Rscript.',
          recommendedCmd: RMARKDOWN_INSTALL_CMD,
          installable: true,
        },
        {
          id: 'pandoc',
          label: 'Pandoc',
          status: 'missing',
          detail:
            'Install Pandoc or add it to PATH. Get it opens the official Pandoc installation instructions.',
          recommendedCmd: 'sudo apt-get install pandoc',
          downloadUrl: 'https://pandoc.org/installing.html',
          installable: false,
        },
      ],
    },
  ],
}

const SUBJDIR_MKDIR_CMD = "mkdir -p '/data/deri vatives/freesurfer'"

const SUBJDIR_WARN_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'FreeSurfer',
      checks: [
        {
          id: 'subjdir',
          label: 'SUBJECTS_DIR',
          status: 'warn',
          detail:
            'Create /data/deri vatives/freesurfer now, or let Supraspina create it automatically when reconstruction runs with the FreeSurfer backend; its parent is writable.',
          recommendedCmd: SUBJDIR_MKDIR_CMD,
          installable: false,
          action: { kind: 'create-directory', label: 'Create directory' },
        },
      ],
    },
  ],
}

// Carry the same quoted command on a check the reconstruction stage requires,
// so the install plan keeps its exact shell quoting.
const QUOTED_REQUIRED_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'FreeSurfer',
      checks: [
        {
          id: 'fshome',
          label: 'FREESURFER_HOME',
          status: 'missing',
          recommendedCmd: SUBJDIR_MKDIR_CMD,
          installable: false,
        },
      ],
    },
  ],
}

const MCR_SELECTED_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'MATLAB / MATLAB Runtime',
      checks: [
        {
          id: 'matlab',
          label: 'MATLAB (optional source backend)',
          status: 'skipped',
          detail:
            'MATLAB Runtime runs ENIGMA QC because source MATLAB is neither on PATH nor configured.',
        },
        {
          id: 'matlabBoot',
          label: 'MATLAB boot',
          status: 'skipped',
          detail:
            'Supraspina does not probe the MATLAB cold start because startup is slow; run MATLAB manually to check it.',
        },
        {
          id: 'mcr',
          label: 'MATLAB Runtime',
          status: 'found',
          detail:
            '/usr/local/MATLAB/MATLAB_Runtime/v97 (R2019b == 9.7) contains runtime/glnxa64/libmwmclmcrrt.so.9.7.',
        },
      ],
    },
  ],
}

// Report a runtime the probe accepted without naming where it lives.
const PATHLESS_MCR_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'MATLAB / MATLAB Runtime',
      checks: [
        {
          id: 'mcr',
          label: 'MATLAB Runtime',
          status: 'found',
          detail: 'Confirm the runtime library is present.',
        },
      ],
    },
  ],
}

const MCR_ONE_LINER =
  'curl -fsSLO https://ssd.mathworks.com/supportfiles/downloads/R2019b/Release/9/deployment_files/installer/complete/glnxa64/MATLAB_Runtime_R2019b_Update_9_glnxa64.zip && unzip MATLAB_Runtime_R2019b_Update_9_glnxa64.zip -d mcr_installer && sudo ./mcr_installer/install -mode silent -agreeToLicense yes -destinationFolder /usr/local/MATLAB'

// Mirror the sidecar shapes under the default matlab backend: the selected
// backend is missing with the official destination, and the unselected MCR
// row is skipped but keeps its full license-free remediation.
const MATLAB_SELECTED_MISSING_REPORT: EnvReport = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  availableMemoryGB: 24,
  groups: [
    {
      name: 'MATLAB / MATLAB Runtime',
      checks: [
        {
          id: 'matlab',
          label: 'MATLAB',
          status: 'missing',
          detail:
            'Install licensed MATLAB with the Image Processing Toolbox, then choose its matlab executable in the ENIGMA QC configuration on the Diagnostics screen, or add matlab to PATH.',
          downloadUrl: 'https://www.mathworks.com/products/matlab.html',
        },
        {
          id: 'matlabBoot',
          label: 'MATLAB boot',
          status: 'skipped',
          detail:
            'Supraspina does not probe the MATLAB cold start because startup is slow; run MATLAB manually to check it.',
        },
        {
          id: 'mcr',
          label: 'MATLAB Runtime (optional compiled backend)',
          status: 'skipped',
          detail:
            'Select the installed R2019b (9.7) MATLAB Runtime root for the compiled ENIGMA QC backend. This backend is optional because source MATLAB is the selected ENIGMA QC backend. Use it as the license-free alternative by selecting the mcr backend in the ENIGMA QC step options; the compiled route requires the R2019b (9.7) MATLAB Runtime and the verified compiled ENIGMA assets.',
          recommendedCmd: MCR_ONE_LINER,
          downloadUrl:
            'https://www.mathworks.com/products/compiler/matlab-runtime.html',
          installable: false,
        },
      ],
    },
  ],
}

const READY_APPTAINER: ManagedResourceRuntime = {
  found: true,
  path: '/usr/bin/apptainer',
  version: '1.5.3',
  expectedVersion: '1.5.3',
  ready: true,
  detail: null,
}

function resourceStatus(
  resource: 'synthstrip' | 'fastsurfer',
  variant: 'cpu' | 'cuda',
  overrides: Partial<ManagedResourceStatusResult> = {},
): ManagedResourceStatusResult {
  return {
    resource,
    variant,
    version: resource === 'synthstrip' ? '1.8' : '2.5.4',
    state: 'missing',
    phase: 'idle',
    operationId: null,
    percent: null,
    cancellable: false,
    error: null,
    runtime: READY_APPTAINER,
    ...overrides,
  } as ManagedResourceStatusResult
}

function resourceLifecycle(
  resource: 'synthstrip' | 'fastsurfer',
  variant: 'cpu' | 'cuda',
  overrides: Partial<ManagedResourceStatusResult> = {},
): ManagedResourceStatus {
  // The progress channel publishes the lifecycle snapshot alone; only the
  // status response carries host Apptainer readiness.
  const full: Record<string, unknown> = {
    ...resourceStatus(resource, variant, overrides),
  }
  delete full.runtime
  return full as unknown as ManagedResourceStatus
}

function Bootstrap({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  const booted = useRef(false)
  useLayoutEffect(() => {
    if (booted.current) return
    booted.current = true
    app.markProjectCreated({
      project: DIAGNOSTICS_PROJECT,
      cfg: DIAGNOSTICS_CONFIG,
      configSha256: '0'.repeat(64),
    })
  }, [app])
  return children
}

/** Build one installation snapshot for the project this harness renders. */
function installState(
  checkId: string,
  patch: Partial<EnvInstallState> = {},
): EnvInstallState {
  return {
    operationId: 'install-0123456789ab',
    checkId,
    projectId: DIAGNOSTICS_PROJECT.projectId,
    projectEpoch: DIAGNOSTICS_PROJECT.epoch,
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

function renderScreen(node: ReactNode): ReturnType<typeof render> {
  return render(
    <AppProvider>
      <Bootstrap>{node}</Bootstrap>
    </AppProvider>,
  )
}

function RoutePeek(): ReactNode {
  const { route } = useApp()
  return <span>route:{route}</span>
}

function RevisionHarness({ children }: { children: ReactNode }): ReactNode {
  const app = useApp()
  return (
    <>
      <button
        type="button"
        onClick={() =>
          app.setCfg({
            ...app.cfg,
            project: { ...app.cfg.project, name: 'Revised diagnostics' },
          })
        }
      >
        Revise config
      </button>
      {children}
    </>
  )
}

function ManagedResourceRevisionHarness(): ReactNode {
  const app = useApp()
  return (
    <>
      <button
        type="button"
        onClick={() =>
          app.setCfg({
            ...app.cfg,
            project: { ...app.cfg.project, name: 'Revised diagnostics' },
          })
        }
      >
        Revise resource config
      </button>
      <button type="button" onClick={() => void app.saveProject()}>
        Save revised config
      </button>
      <ScientificResourcesPanel safeExecution={false} />
    </>
  )
}

function HostManagedResourceHarness(): ReactNode {
  const app = useApp()
  if (!app.hostState) return null
  return <ScientificResourcesPanel safeExecution={false} />
}

function electronHostState(
  overrides: Partial<HostState['sidecar']> = {},
): HostState {
  return {
    mode: 'electron',
    platform: 'linux',
    captionMode: 'custom',
    sidecar: {
      state: 'ready',
      generation: 1,
      productVersion: '1.0.0',
      protocolVersion: '1',
      persistenceVersions: {
        project: 1,
        runState: 1,
        manifest: 1,
        receipt: 1,
      },
      capabilities: ['managed-scientific-resources-v1'],
      runtimeId: 'diagnostics-runtime-1',
      projectAttached: true,
      retryable: false,
      detail: null,
      ...overrides,
    },
  }
}

function ConfigProbe(): ReactNode {
  const { cfg, dirty } = useApp()
  return (
    <output data-testid="config-probe">
      {`${dirty ? 'dirty' : 'clean'}:${String(
        cfg.steps.pybrainage.params['pythonExecutable'] ?? '',
      )}:${cfg.tools.pythonExecutable}`}
    </output>
  )
}

function LicenseConfigProbe(): ReactNode {
  const { cfg, dirty } = useApp()
  return (
    <output data-testid="license-config-probe">
      {`${dirty ? 'dirty' : 'clean'}:${cfg.tools.freesurferLicense || '(none)'}`}
    </output>
  )
}

function FreesurferHomeConfigProbe(): ReactNode {
  const { cfg, dirty } = useApp()
  return (
    <output data-testid="freesurfer-home-config-probe">
      {`${dirty ? 'dirty' : 'clean'}:${cfg.tools.freesurferHome || '(none)'}`}
    </output>
  )
}

/** Pin the compiled backend so no report is needed to name the selection. */
function mcrBackendConfig(): typeof DIAGNOSTICS_CONFIG {
  return {
    ...DIAGNOSTICS_CONFIG,
    steps: {
      ...DIAGNOSTICS_CONFIG.steps,
      enigma: {
        ...DIAGNOSTICS_CONFIG.steps.enigma,
        params: {
          ...DIAGNOSTICS_CONFIG.steps.enigma.params,
          backend: 'mcr',
        },
      },
    },
  }
}

function EnigmaConfigProbe(): ReactNode {
  const { cfg, dirty } = useApp()
  const executable = String(cfg.steps.enigma.params['matlabExecutable'] ?? '')
  const mcrRoot = String(cfg.steps.enigma.params['mcrRoot'] ?? '')
  return (
    <output data-testid="enigma-config-probe">
      {`${dirty ? 'dirty' : 'clean'}:${executable || '(none)'}:${mcrRoot || '(none)'}`}
    </output>
  )
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function singleCheckReport(label: string): EnvReport {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    availableMemoryGB: 24,
    groups: [
      {
        // Use a check the outlier-review stage requires so the group expands.
        name: 'Revision guard',
        checks: [{ id: 'rscript', label, status: 'missing' }],
      },
    ],
  }
}

function findCallout(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Recommended fix' })
}

function envRow(checkId: string): HTMLElement {
  const row = document.getElementById(`env-check-${checkId}`)
  if (!row) throw new Error(`Render the ${checkId} row.`)
  return row
}

function findLoaded(): Promise<HTMLElement> {
  return findCallout()
}

function expandGroup(name: string, count = 'required, all found'): void {
  const button = screen.getByRole('button', {
    name: new RegExp(`${name}.*${count}`, 'i'),
  })
  fireEvent.click(button)
}

/**
 * Reveal the advisory SUBJECTS_DIR row. No stage requires the directory check,
 * so its group stays collapsed until the reader opens it.
 */
function expandAdvisoryFreesurferGroup(): void {
  expandGroup('FreeSurfer', 'none required')
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DiagnosticsScreen', () => {
  it('chooses the FreeSurfer installation root through the native directory picker', async () => {
    const api = getApi()
    const chooseDir = vi
      .spyOn(api.fs, 'chooseDir')
      .mockResolvedValue('/usr/local/freesurfer/8.2.0')
    renderScreen(
      <>
        <DiagnosticsScreen report={EMPTY_REPORT} />
        <FreesurferHomeConfigProbe />
      </>,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Choose installation root for FreeSurfer',
      }),
    )

    await waitFor(() =>
      expect(
        screen.getByTestId('freesurfer-home-config-probe'),
      ).toHaveTextContent('dirty:/usr/local/freesurfer/8.2.0'),
    )
    expect(chooseDir).toHaveBeenCalledWith({})
    expect(
      screen.getByRole('group', { name: 'FreeSurfer installation root' }),
    ).toHaveTextContent('Configured')
  })

  it('chooses a FreeSurfer license through the native picker without exposing its contents', async () => {
    const api = getApi()
    const chooseFile = vi
      .spyOn(api.fs, 'chooseFile')
      .mockResolvedValue('/home/sci/Downloads/license.txt')
    renderScreen(
      <>
        <DiagnosticsScreen report={EMPTY_REPORT} />
        <LicenseConfigProbe />
      </>,
    )

    expect(
      within(
        screen.getByRole('group', {
          name: 'FreeSurfer license configuration',
        }),
      ).getByText('Not configured'),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Choose license file for FreeSurfer',
      }),
    )

    await waitFor(() =>
      expect(screen.getByTestId('license-config-probe')).toHaveTextContent(
        'dirty:/home/sci/Downloads/license.txt',
      ),
    )
    // The license filter comes first; All files reaches any other name.
    expect(chooseFile).toHaveBeenCalledWith({
      filters: [
        { name: 'FreeSurfer license', extensions: ['txt', 'license'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    expect(screen.getByText('Configured')).toBeInTheDocument()
    expect(
      screen.queryByText('/home/sci/Downloads/license.txt'),
    ).not.toBeInTheDocument()
  })

  it('states how the FreeSurfer license path is handled as facts', () => {
    renderScreen(<DiagnosticsScreen report={EMPTY_REPORT} />)

    const group = screen.getByRole('group', {
      name: 'FreeSurfer license configuration',
    })
    expect(group).toHaveTextContent(/^License file/)
    // Electron's Linux dialog lists no dotfile under any filter until
    // Ctrl+H, so the info tip says how to reach a license saved as .license.
    expect(
      within(group).getByRole('button', { name: 'About license file' }),
    ).toHaveAccessibleDescription(
      'Only the path is saved; Supraspina never reads the license. Press Ctrl+H in the file dialog to show a hidden .license file.',
    )
    expect(group).not.toHaveTextContent(/\bTreat\b|\bKeep\b/)
    // The visible label is short; the accessible name keeps the target.
    expect(
      within(group).getByRole('button', {
        name: 'Choose license file for FreeSurfer',
      }),
    ).toHaveTextContent(/^Choose\.\.\.$/)
  })

  it('explains each configuration row in an info tip, not a sentence', () => {
    renderScreen(<DiagnosticsScreen report={EMPTY_REPORT} />)

    const tips: [string, string, string][] = [
      [
        'FreeSurfer installation root',
        'About installation root',
        'The FreeSurfer 8.x folder. Saved with the project.',
      ],
      [
        'ENIGMA QC backend selection and readiness',
        'About backend',
        'Set in the ENIGMA QC step on the Pipeline screen.',
      ],
      [
        'MATLAB executable configuration',
        'About MATLAB executable',
        'Leave unset to use matlab on PATH.',
      ],
      [
        'MATLAB Runtime root configuration',
        'About MATLAB Runtime root',
        'The R2019b (9.7) runtime folder. Leave unset to use a detected one.',
      ],
    ]
    for (const [group, label, text] of tips) {
      expect(
        within(screen.getByRole('group', { name: group })).getByRole('button', {
          name: label,
        }),
      ).toHaveAccessibleDescription(text)
    }
    expect(
      screen.getByRole('group', {
        name: 'ENIGMA QC backend selection and readiness',
      }),
    ).toHaveTextContent(/^Backend/)
    expect(
      screen.getByRole('button', {
        name: 'Choose installation root for FreeSurfer',
      }),
    ).toHaveTextContent(/^Choose\.\.\.$/)
    // No explanation sits under the row labels.
    expect(
      screen.queryByText(/The FreeSurfer 8\.x installation directory/),
    ).toBeNull()
    expect(
      screen.queryByText(/needs no MATLAB license but requires/),
    ).toBeNull()
  })

  it('lists the environment checks before resources and configuration', async () => {
    renderScreen(<DiagnosticsScreen />)
    const callout = await findCallout()
    const resources = await screen.findByRole('group', {
      name: 'Scientific resources',
    })
    const config = screen.getByRole('group', {
      name: 'FreeSurfer installation root',
    })
    expect(
      callout.compareDocumentPosition(resources) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      resources.compareDocumentPosition(config) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('leaves the FreeSurfer license unchanged when its picker is canceled', async () => {
    vi.spyOn(getApi().fs, 'chooseFile').mockResolvedValue(null)
    renderScreen(
      <>
        <DiagnosticsScreen report={EMPTY_REPORT} />
        <LicenseConfigProbe />
      </>,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Choose license file for FreeSurfer',
      }),
    )

    await waitFor(() => expect(getApi().fs.chooseFile).toHaveBeenCalledOnce())
    expect(screen.getByTestId('license-config-probe')).toHaveTextContent(
      'clean:(none)',
    )
  })

  it('surfaces a FreeSurfer license picker failure without changing config', async () => {
    vi.spyOn(getApi().fs, 'chooseFile').mockRejectedValue(
      new Error('Retry the native file picker.'),
    )
    renderScreen(
      <>
        <DiagnosticsScreen report={EMPTY_REPORT} />
        <LicenseConfigProbe />
      </>,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Choose license file for FreeSurfer',
      }),
    )

    expect(
      await screen.findByText(
        'Choose the FreeSurfer license again: Retry the native file picker.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId('license-config-probe')).toHaveTextContent(
      'clean:(none)',
    )
  })

  it('shows managed SynthStrip and FastSurfer variants with a visible safety gate', async () => {
    const status = vi.spyOn(getApi().managedResource, 'status')
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={false} />,
    )

    expect(
      await screen.findByRole('group', { name: 'Scientific resources' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'SynthStrip CPU' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'FastSurfer CPU' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'FastSurfer CUDA' }),
    ).toBeInTheDocument()
    expect(status).toHaveBeenCalledTimes(3)
    // Each resource states its role in one short line.
    for (const line of [
      'Brain masks and field-of-view crop.',
      'FastSurfer reconstruction without a GPU.',
      'FastSurfer reconstruction on an NVIDIA GPU.',
    ]) {
      expect(screen.getByText(line)).toBeInTheDocument()
    }
    // The section explanation sits in an info tip after the heading.
    expect(
      screen.getByRole('button', { name: 'About scientific resources' }),
    ).toHaveAccessibleDescription(
      'Container images (SIF files) are stored on this computer, outside the app. Download needs Apptainer; importing a file does not.',
    )
    expect(
      screen.getByText('Allow live runs to download or import a resource.'),
    ).toBeInTheDocument()
    const provisions = screen.getAllByRole('button', { name: /^Provision / })
    expect(provisions).toHaveLength(3)
    for (const button of provisions) {
      expect(button).toBeDisabled()
      expect(button).toHaveTextContent(/^Download$/)
      expect(button).toHaveAttribute(
        'title',
        'Allow live runs to download or import a resource.',
      )
    }
    for (const button of screen.getAllByRole('button', {
      name: /^Import .* SIF$/,
    })) {
      expect(button).toHaveTextContent(/^Import file\.\.\.$/)
    }
    expect(screen.queryByText(/license.*[/\\]/i)).not.toBeInTheDocument()
  })

  it('refuses provisioning with a save control while the project has unsaved edits', async () => {
    vi.spyOn(getApi().managedResource, 'status').mockImplementation(
      async ({ resource, variant }) => resourceStatus(resource, variant),
    )
    const provision = vi.spyOn(getApi().provision, 'fastsurfer')
    const saveSpy = vi.spyOn(getApi().project, 'save')
    renderScreen(
      <RevisionHarness>
        <ScientificResourcesPanel safeExecution={true} />
      </RevisionHarness>,
    )
    const button = await screen.findByRole('button', {
      name: 'Provision FastSurfer CPU',
    })
    await waitFor(() => expect(button).toBeEnabled())

    // With an unsaved edit the panel refuses Provision and offers the save it
    // needs.
    fireEvent.click(screen.getByRole('button', { name: 'Revise config' }))
    expect(
      screen.getByRole('button', { name: 'Provision FastSurfer CPU' }),
    ).toBeDisabled()
    expect(
      screen.getByText('Save the project to download or import a resource.'),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Save the project to download or import a resource',
      }),
    )
    await waitFor(() => expect(saveSpy).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Provision FastSurfer CPU' }),
      ).toBeEnabled(),
    )
    expect(provision).not.toHaveBeenCalled()
  })

  it('offers the save that the scientific resource check waits for', async () => {
    const status = vi
      .spyOn(getApi().managedResource, 'status')
      .mockImplementation(async ({ resource, variant }) =>
        resourceStatus(resource, variant),
      )
    renderScreen(
      <RevisionHarness>
        <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />
      </RevisionHarness>,
    )
    await screen.findByRole('button', { name: 'Provision FastSurfer CPU' })
    fireEvent.click(screen.getByRole('button', { name: 'Revise config' }))
    expect(
      screen.getByText('Save the project to check scientific resources.'),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Save the project to check scientific resources',
      }),
    )
    await waitFor(() =>
      expect(status).toHaveBeenLastCalledWith(
        expect.objectContaining({ configRevision: 1 }),
      ),
    )
    expect(
      await screen.findByRole('button', { name: 'Provision FastSurfer CPU' }),
    ).toBeEnabled()
  })

  it('waits for a booting desktop sidecar to be ready and project-attached before inspecting resources', async () => {
    const api = getApi()
    let hostListener: ((state: HostState) => void) | null = null
    vi.spyOn(api.host, 'getState').mockResolvedValue(
      electronHostState({
        state: 'booting',
        projectAttached: false,
        runtimeId: null,
      }),
    )
    vi.spyOn(api.host, 'onState').mockImplementation((listener) => {
      hostListener = listener
      return vi.fn()
    })
    const status = vi
      .spyOn(api.managedResource, 'status')
      .mockImplementation(async ({ resource, variant }) =>
        resourceStatus(resource, variant, { state: 'ready', phase: 'done' }),
      )

    renderScreen(<HostManagedResourceHarness />)

    await screen.findByRole('group', { name: 'Scientific resources' })
    expect(status).not.toHaveBeenCalled()
    // The wait is stated as a fact, not as an order to wait.
    expect(
      screen.getByText('The scientific runtime is not ready yet.'),
    ).toHaveAttribute('role', 'status')

    act(() => {
      hostListener?.(
        electronHostState({
          state: 'ready',
          projectAttached: true,
          runtimeId: 'diagnostics-runtime-1',
        }),
      )
    })

    await waitFor(() => expect(status).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('3/3 ready')).toBeInTheDocument()
  })

  it('waits for the first native host-state snapshot before inspecting resources', async () => {
    const api = getApi()
    const nativeApi = api as typeof api & { __mock?: true }
    const initialHostState = deferred<HostState>()
    delete nativeApi.__mock
    vi.spyOn(api.host, 'getState').mockReturnValue(initialHostState.promise)
    const status = vi
      .spyOn(api.managedResource, 'status')
      .mockImplementation(async ({ resource, variant }) =>
        resourceStatus(resource, variant, { state: 'ready', phase: 'done' }),
      )

    try {
      renderScreen(<ScientificResourcesPanel safeExecution={false} />)

      await waitFor(() => expect(api.host.getState).toHaveBeenCalledOnce())
      expect(status).not.toHaveBeenCalled()

      await act(async () => {
        initialHostState.resolve(electronHostState())
        await initialHostState.promise
      })

      await waitFor(() => expect(status).toHaveBeenCalledTimes(3))
      expect(await screen.findByText('3/3 ready')).toBeInTheDocument()
    } finally {
      nativeApi.__mock = true
    }
  })

  it('clears a stale availability error and retries after a sidecar generation restart', async () => {
    const api = getApi()
    let hostListener: ((state: HostState) => void) | null = null
    vi.spyOn(api.host, 'getState').mockResolvedValue(
      electronHostState({ generation: 4, runtimeId: 'diagnostics-runtime-4' }),
    )
    vi.spyOn(api.host, 'onState').mockImplementation((listener) => {
      hostListener = listener
      return vi.fn()
    })
    let serveReadyStatus = false
    const status = vi
      .spyOn(api.managedResource, 'status')
      .mockImplementation(async ({ resource, variant }) => {
        if (!serveReadyStatus) {
          throw new Error(
            'SidecarAvailabilityError: Refresh the stale scientific runtime generation.',
          )
        }
        return resourceStatus(resource, variant, {
          state: 'ready',
          phase: 'done',
        })
      })

    renderScreen(<HostManagedResourceHarness />)

    expect(
      await screen.findByText(/SidecarAvailabilityError/),
    ).toBeInTheDocument()
    expect(status).toHaveBeenCalledTimes(3)

    act(() => {
      hostListener?.(
        electronHostState({
          state: 'restarting',
          generation: 5,
          runtimeId: null,
          projectAttached: false,
        }),
      )
    })

    await waitFor(() =>
      expect(
        screen.queryByText(/SidecarAvailabilityError/),
      ).not.toBeInTheDocument(),
    )
    expect(status).toHaveBeenCalledTimes(3)

    serveReadyStatus = true
    act(() => {
      hostListener?.(
        electronHostState({
          state: 'ready',
          generation: 5,
          runtimeId: 'diagnostics-runtime-5',
          projectAttached: true,
        }),
      )
    })

    await waitFor(() => expect(status).toHaveBeenCalledTimes(6))
    expect(await screen.findByText('3/3 ready')).toBeInTheDocument()
  })

  it('authorizes and starts pinned provisioning from a focus-safe dialog', async () => {
    const api = getApi()
    vi.spyOn(api.managedResource, 'status').mockImplementation(
      async ({ resource, variant }) => resourceStatus(resource, variant),
    )
    const provision = vi
      .spyOn(api.provision, 'fastsurfer')
      .mockResolvedValue({ operationId: `resource-${'a'.repeat(12)}` })
    const authorize = vi.spyOn(api.execution, 'authorize')
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )
    await screen.findByRole('heading', { name: 'FastSurfer CPU' })

    fireEvent.click(
      screen.getByRole('button', { name: 'Provision FastSurfer CPU' }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm provisioning of FastSurfer CPU',
    })
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Cancel' }),
      ).toHaveFocus(),
    )
    expect(dialog).toHaveTextContent(/immutable OCI digest/)
    expect(dialog).toHaveTextContent(/Apptainer installation/)
    expect(dialog).toHaveTextContent(/exact size and SHA-256/)
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Authorize provision',
      }),
    )

    await waitFor(() => expect(provision).toHaveBeenCalledOnce())
    expect(authorize).toHaveBeenCalledWith({
      project: DIAGNOSTICS_PROJECT,
      configRevision: 0,
      purpose: 'provision',
    })
    expect(provision).toHaveBeenCalledWith({
      project: DIAGNOSTICS_PROJECT,
      cfg: expect.objectContaining({
        paths: expect.objectContaining({
          projectRoot: DIAGNOSTICS_PROJECT.root,
        }),
      }),
      configRevision: 0,
      variant: 'cpu',
      authorization: expect.objectContaining({ purpose: 'provision' }),
    })
  })

  it('keeps the provisioning dialog open with the sidecar-authored Apptainer guidance', async () => {
    const api = getApi()
    vi.spyOn(api.managedResource, 'status').mockImplementation(
      async ({ resource, variant }) => resourceStatus(resource, variant),
    )
    vi.spyOn(api.provision, 'fastsurfer').mockRejectedValue(
      new Error(
        'Install Apptainer 1.5.3 to pull managed resources, following the ' +
          'supported-Ubuntu steps in the Supraspina installation guide, or ' +
          'import a verified SIF offline.',
      ),
    )
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )
    await screen.findByRole('heading', { name: 'FastSurfer CPU' })

    fireEvent.click(
      screen.getByRole('button', { name: 'Provision FastSurfer CPU' }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm provisioning of FastSurfer CPU',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Authorize provision' }),
    )

    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/Install Apptainer/)
    expect(alert).toHaveTextContent(/import a verified SIF offline/)
  })

  it('shows the sidecar-authored error for a failed managed-resource operation', async () => {
    const api = getApi()
    let progress: ((event: ManagedResourceProgress) => void) | null = null
    vi.spyOn(api.managedResource, 'onProgress').mockImplementation(
      (callback) => {
        progress = callback
        return vi.fn()
      },
    )
    vi.spyOn(api.managedResource, 'status').mockImplementation(
      async ({ resource, variant }) => resourceStatus(resource, variant),
    )
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )
    await screen.findByRole('heading', { name: 'FastSurfer CPU' })

    act(() => {
      progress?.({
        ...resourceLifecycle('fastsurfer', 'cpu', {
          phase: 'error',
          operationId: `resource-${'d'.repeat(12)}`,
          percent: null,
          cancellable: false,
          error:
            'Inspect the failed managed-resource Apptainer pull (exit status 3).',
        }),
        projectId: DIAGNOSTICS_PROJECT.projectId,
        projectEpoch: DIAGNOSTICS_PROJECT.epoch,
      })
    })

    const card = screen
      .getByRole('heading', { name: 'FastSurfer CPU' })
      .closest('article')
    if (!card) throw new Error('Render the FastSurfer CPU card.')
    expect(within(card).getByRole('alert')).toHaveTextContent(
      'Inspect the failed managed-resource Apptainer pull (exit status 3).',
    )
  })

  it('imports an offline SIF through the native picker and identical verifier', async () => {
    const api = getApi()
    vi.spyOn(api.managedResource, 'status').mockImplementation(
      async ({ resource, variant }) => resourceStatus(resource, variant),
    )
    vi.spyOn(api.fs, 'chooseFile').mockResolvedValue('/offline/synthstrip.sif')
    const importOffline = vi
      .spyOn(api.managedResource, 'importOffline')
      .mockResolvedValue({ operationId: `resource-${'b'.repeat(12)}` })
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )
    await screen.findByRole('heading', { name: 'SynthStrip CPU' })

    fireEvent.click(
      screen.getByRole('button', { name: 'Import SynthStrip CPU SIF' }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Confirm import of SynthStrip CPU SIF',
    })
    expect(dialog).toHaveTextContent(/same size and SHA-256 checks/)
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Authorize import' }),
    )

    await waitFor(() => expect(importOffline).toHaveBeenCalledOnce())
    expect(api.fs.chooseFile).toHaveBeenCalledWith({
      filters: [{ name: 'Apptainer image', extensions: ['sif'] }],
    })
    expect(importOffline).toHaveBeenCalledWith({
      project: DIAGNOSTICS_PROJECT,
      cfg: expect.any(Object),
      configRevision: 0,
      resource: 'synthstrip',
      variant: 'cpu',
      sourcePath: '/offline/synthstrip.sif',
      authorization: expect.objectContaining({ purpose: 'provision' }),
    })
  })

  it('streams revision-matched progress and cancels the exact resource operation', async () => {
    const api = getApi()
    let progress: ((event: ManagedResourceProgress) => void) | null = null
    vi.spyOn(api.managedResource, 'onProgress').mockImplementation(
      (callback) => {
        progress = callback
        return vi.fn()
      },
    )
    vi.spyOn(api.managedResource, 'status').mockImplementation(
      async ({ resource, variant }) => resourceStatus(resource, variant),
    )
    const cancel = vi.spyOn(api.managedResource, 'cancel').mockResolvedValue({
      operationId: `resource-${'c'.repeat(12)}`,
      accepted: true,
      terminal: false,
    })
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )
    await screen.findByRole('heading', { name: 'FastSurfer CUDA' })

    act(() => {
      progress?.({
        ...resourceLifecycle('fastsurfer', 'cuda', {
          phase: 'pulling',
          operationId: `resource-${'c'.repeat(12)}`,
          percent: 42,
          cancellable: true,
        }),
        projectId: DIAGNOSTICS_PROJECT.projectId,
        projectEpoch: DIAGNOSTICS_PROJECT.epoch,
      })
    })
    const card = screen
      .getByRole('heading', { name: 'FastSurfer CUDA' })
      .closest('article')
    if (!card) throw new Error('Render the FastSurfer CUDA card.')
    expect(within(card).getByRole('progressbar')).toHaveAttribute('value', '42')
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Cancel FastSurfer CUDA provisioning',
      }),
    )
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith({
        project: DIAGNOSTICS_PROJECT,
        cfg: expect.any(Object),
        configRevision: 0,
        resource: 'fastsurfer',
        variant: 'cuda',
        operationId: `resource-${'c'.repeat(12)}`,
      }),
    )
  })

  it('shows the detected Apptainer beside the release the pins require', async () => {
    const api = getApi()
    vi.spyOn(api.managedResource, 'status').mockImplementation(
      async ({ resource, variant }) => resourceStatus(resource, variant),
    )
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )

    const row = (
      await screen.findByRole('heading', { name: 'Apptainer runtime' })
    ).closest('article')
    if (!row) throw new Error('Render the Apptainer runtime row.')
    // A page-level section heading takes the serif display face.
    expect(
      screen.getByRole('heading', { name: 'Scientific resources' }).style
        .fontFamily,
    ).toContain('WebCM Serif 10')
    expect(row).toHaveTextContent('Apptainer 1.5.3 at /usr/bin/apptainer')
    // The required release sits in the chip title, not in the row.
    expect(row).not.toHaveTextContent('Online provisioning reproduces')
    expect(within(row).getByText('Ready').closest('[title]')).toHaveAttribute(
      'title',
      'Online provisioning reproduces the pinned SIFs only with Apptainer 1.5.3.',
    )
    expect(
      within(row).queryByRole('button', { name: /Apptainer releases/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Provision FastSurfer CPU' }),
    ).toBeEnabled()
  })

  it('blocks only online provisioning while the Apptainer runtime is not ready', async () => {
    const api = getApi()
    vi.spyOn(api.managedResource, 'status').mockImplementation(
      async ({ resource, variant }) =>
        resourceStatus(resource, variant, {
          runtime: {
            found: true,
            path: '/opt/apptainer/bin/apptainer',
            version: '1.4.2',
            expectedVersion: '1.5.3',
            ready: false,
            detail:
              'Install Apptainer 1.5.3 to reproduce the pinned ' +
              'managed-resource SIF; this machine has Apptainer 1.4.2. ' +
              'Import a verified SIF offline instead.',
          },
        }),
    )
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )

    const row = (
      await screen.findByRole('heading', { name: 'Apptainer runtime' })
    ).closest('article')
    if (!row) throw new Error('Render the Apptainer runtime row.')
    expect(row).toHaveTextContent(
      'Apptainer 1.4.2 at /opt/apptainer/bin/apptainer',
    )
    expect(within(row).getByText('Not ready')).toBeInTheDocument()
    expect(row).toHaveTextContent('this machine has Apptainer 1.4.2')
    // The remediation sets its versions in inline mono like the evidence line.
    const status = within(row).getByRole('status')
    expect(status).toHaveTextContent(/^Install Apptainer 1\.5\.3 to reproduce/)
    expect(
      Array.from(status.querySelectorAll('code'), (code) => code.textContent),
    ).toEqual(['1.5.3', '1.4.2'])

    const provision = screen.getByRole('button', {
      name: /^Provision FastSurfer CPU, unavailable: /,
    })
    expect(provision).toBeDisabled()
    expect(provision).toHaveAccessibleName(
      /Install Apptainer 1\.5\.3 to provision resources online/,
    )
    // Offline import verifies an existing SIF and never invokes Apptainer.
    expect(
      screen.getByRole('button', { name: 'Import FastSurfer CPU SIF' }),
    ).toBeEnabled()
  })

  it('rechecks the Apptainer runtime with the section refresh', async () => {
    const api = getApi()
    let ready = false
    const status = vi
      .spyOn(api.managedResource, 'status')
      .mockImplementation(async ({ resource, variant }) =>
        resourceStatus(resource, variant, {
          runtime: ready
            ? READY_APPTAINER
            : {
                found: false,
                path: null,
                version: null,
                expectedVersion: '1.5.3',
                ready: false,
                detail:
                  'Install Apptainer 1.5.3 to pull managed resources, following ' +
                  'the supported-Ubuntu steps in the Supraspina installation ' +
                  'guide, or import a verified SIF offline.',
              },
        }),
      )
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )

    expect(
      await screen.findByText('No Apptainer executable was found on PATH.', {
        exact: false,
      }),
    ).toBeInTheDocument()
    await waitFor(() => expect(status).toHaveBeenCalledTimes(3))

    // The section refresh is the one recheck; no row duplicates it.
    expect(
      screen.queryByRole('button', { name: 'Recheck Apptainer' }),
    ).toBeNull()
    ready = true
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh scientific resources' }),
    )

    await waitFor(() => expect(status).toHaveBeenCalledTimes(6))
    // The evidence sentence is sans; its version and path are inline code.
    const path = await screen.findByText('/usr/bin/apptainer')
    expect(path.tagName).toBe('CODE')
    expect(path.parentElement).toHaveTextContent(
      'Apptainer 1.5.3 at /usr/bin/apptainer.',
    )
    expect(path.parentElement?.style.fontFamily).toContain('WebCM Sans 10')
  })

  it('reports a refused Apptainer releases destination instead of staying silent', async () => {
    const api = getApi()
    vi.spyOn(api.managedResource, 'status').mockImplementation(
      async ({ resource, variant }) =>
        resourceStatus(resource, variant, {
          runtime: {
            found: false,
            path: null,
            version: null,
            expectedVersion: '1.5.3',
            ready: false,
            detail: 'Install Apptainer to pull managed resources.',
          },
        }),
    )
    const openWeb = vi
      .spyOn(api.external, 'openWeb')
      .mockRejectedValue(new Error('Refuse the destination.'))
    renderScreen(
      <DiagnosticsScreen report={EMPTY_REPORT} safeExecution={true} />,
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open the Apptainer releases download page',
      }),
    )

    expect(openWeb).toHaveBeenCalledWith({
      url: 'https://github.com/apptainer/apptainer/releases',
      purpose: 'download',
    })
    expect(
      await screen.findByText(
        'Open the Apptainer releases page manually; Supraspina refused it.',
      ),
    ).toBeInTheDocument()
  })

  it('retries managed resource status after saving and ignores a stale request error', async () => {
    let rejectInitial!: (reason: unknown) => void
    const initial = new Promise<ManagedResourceStatusResult>(
      (_resolve, reject) => {
        rejectInitial = reject
      },
    )
    const saved = deferred<void>()
    const status = vi
      .spyOn(getApi().managedResource, 'status')
      .mockImplementation(({ resource, variant, configRevision }) =>
        configRevision === 0
          ? initial
          : saved.promise.then(() =>
              resourceStatus(resource, variant, {
                state: 'ready',
                phase: 'done',
              }),
            ),
      )

    renderScreen(<ManagedResourceRevisionHarness />)

    await waitFor(() => expect(status).toHaveBeenCalledTimes(3))
    fireEvent.click(
      screen.getByRole('button', { name: 'Revise resource config' }),
    )
    await waitFor(() => expect(status).toHaveBeenCalledTimes(3))
    expect(
      screen.getByText('Save the project to check scientific resources.'),
    ).toBeInTheDocument()
    expect(screen.getByText('save to check')).toBeInTheDocument()
    expect(screen.queryByText('Not installed')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save revised config' }))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(6))
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({ configRevision: 1 }),
    )

    await act(async () => {
      rejectInitial(
        new Error(
          'Save the project at its current revision before checking managedResource.status.',
        ),
      )
      await initial.catch(() => undefined)
    })
    expect(
      screen.queryByText(
        /Save the project at its current revision before checking managedResource\.status\./,
      ),
    ).not.toBeInTheDocument()

    await act(async () => {
      saved.resolve(undefined)
      await saved.promise
    })
    await waitFor(() =>
      expect(screen.getByText('3/3 ready')).toBeInTheDocument(),
    )
  })

  it('binds every managed-resource status call to the saved revision and bytes', async () => {
    const status = vi
      .spyOn(getApi().managedResource, 'status')
      .mockImplementation(async ({ resource, variant }) =>
        resourceStatus(resource, variant, { state: 'ready', phase: 'done' }),
      )

    renderScreen(<ManagedResourceRevisionHarness />)
    await waitFor(() => expect(status).toHaveBeenCalledTimes(3))

    fireEvent.click(
      screen.getByRole('button', { name: 'Revise resource config' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save revised config' }))
    await waitFor(() => expect(status).toHaveBeenCalledTimes(6))

    const revisions = status.mock.calls.map(([call]) => call.configRevision)
    const names = status.mock.calls.map(([call]) => call.cfg.project.name)
    expect(revisions.slice(0, 3)).toEqual([0, 0, 0])
    expect(revisions.slice(3)).toEqual([1, 1, 1])
    expect(names.slice(3)).toEqual([
      'Revised diagnostics',
      'Revised diagnostics',
      'Revised diagnostics',
    ])
    expect(names.slice(0, 3)).not.toContain('Revised diagnostics')
  })

  it('ignores an environment result from an earlier config revision', async () => {
    const prior = deferred<EnvReport>()
    const current = deferred<EnvReport>()
    const check = vi
      .spyOn(getApi().env, 'check')
      .mockImplementation((request) =>
        'configRevision' in request && request.configRevision === 0
          ? prior.promise
          : current.promise,
      )
    renderScreen(
      <RevisionHarness>
        <DiagnosticsScreen />
      </RevisionHarness>,
    )
    await waitFor(() =>
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({ configRevision: 0 }),
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Revise config' }))
    await waitFor(() =>
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({ configRevision: 1 }),
      ),
    )
    await act(async () => {
      current.resolve(singleCheckReport('Current revision check'))
      await current.promise
    })
    // The required check names itself in both the callout and its own row.
    expect(
      (await screen.findAllByText('Current revision check')).length,
    ).toBeGreaterThan(0)

    await act(async () => {
      prior.resolve(singleCheckReport('Stale revision check'))
      await prior.promise
    })
    expect(screen.queryByText('Stale revision check')).not.toBeInTheDocument()
    expect(
      screen.getAllByText('Current revision check').length,
    ).toBeGreaterThan(0)
  })

  it('keeps one installation attached across a config revision change', async () => {
    // The installation belongs to the host and the project generation, not to
    // the draft revision, so a draft edit must not lose its reported outcome.
    const install = mockInstall()
    renderScreen(
      <RevisionHarness>
        <DiagnosticsScreen
          report={INSTALLABLE_REQUIRED_REPORT}
          safeExecution={true}
        />
      </RevisionHarness>,
    )
    fireEvent.click(screen.getAllByRole('button', { name: /^Install / })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))
    await waitFor(() => expect(install.start).toHaveBeenCalledOnce())
    install.publish(installState('rscript'))
    fireEvent.click(screen.getByRole('button', { name: 'Revise config' }))

    install.publish(
      installState('rscript', {
        phase: 'done',
        rc: 0,
        stdout: 'installed Rscript',
      }),
    )
    expect((await screen.findAllByText('rc=0')).length).toBeGreaterThan(0)
    // The settled installation releases the busy label, and the draft edit
    // leaves the row refusing a further install until the project is saved.
    for (const button of screen.getAllByRole('button', { name: /^Install / })) {
      expect(button).toHaveTextContent('Install')
      expect(button).toBeDisabled()
    }
  })

  it('refuses an opt-in install while the project has unsaved edits', async () => {
    const install = mockInstall()
    renderScreen(
      <RevisionHarness>
        <DiagnosticsScreen
          report={INSTALLABLE_REQUIRED_REPORT}
          safeExecution={true}
        />
      </RevisionHarness>,
    )
    expect(
      await screen.findByRole('button', { name: 'Install Rscript' }),
    ).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Revise config' }))
    const blocked = screen.getByRole('button', { name: 'Install Rscript' })
    expect(blocked).toBeDisabled()
    expect(screen.getByText('Needs a saved project')).toBeInTheDocument()
    expect(blocked.parentElement).toHaveAttribute(
      'title',
      'Save the project to install Rscript.',
    )
    fireEvent.click(blocked)
    expect(
      screen.queryByRole('button', { name: 'Authorize install' }),
    ).not.toBeInTheDocument()
    expect(install.start).not.toHaveBeenCalled()

    // The row states the refusal and carries the save it asks for, so the
    // operator does not have to find the toolbar Save.
    const row = envRow('rscript')
    expect(
      within(row).getByText('Save the project to install Rscript.'),
    ).toBeInTheDocument()
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Save the project to install Rscript',
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Install Rscript' }),
      ).toBeEnabled(),
    )
    expect(
      screen.queryByText('Save the project to install Rscript.'),
    ).not.toBeInTheDocument()
  })

  it('offers the offline asset rebuild as one prominent action with its reason', async () => {
    const onSafeExecutionChange = vi.fn()
    renderScreen(
      <DiagnosticsScreen
        report={OFFLINE_REBUILD_REPORT}
        safeExecution={false}
        onSafeExecutionChange={onSafeExecutionChange}
      />,
    )
    const card = await screen.findByRole('region', {
      name: 'Rebuild the scientific assets',
    })
    expect(card).toHaveTextContent(/nothing is downloaded/)
    // The callout is a card, so its title is sans like every card title.
    const title = within(card).getByRole('heading', {
      name: 'Rebuild the scientific assets',
    })
    expect(title.style.fontFamily).toContain('WebCM Sans 10')
    expect(title.style.fontSize).toBe('11px')
    expect(card).toHaveTextContent(
      'Restores ENIGMA QC assets, Feature extraction assets.',
    )
    const rebuild = within(card).getByRole('button', {
      name: 'Rebuild the scientific assets',
    })
    expect(rebuild).toBeDisabled()
    expect(rebuild).toHaveAttribute(
      'title',
      'Allow live runs to rebuild the scientific assets.',
    )
    expect(
      within(card).getByText(
        'Allow live runs to rebuild the scientific assets.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Allow live runs to rebuild the scientific assets',
      }),
    )
    expect(onSafeExecutionChange).toHaveBeenCalledWith(true)

    // The asset rows name the same rebuild and offer no download page.
    const enigma = envRow('enigma_assets')
    expect(
      within(enigma).getByRole('button', { name: 'Rebuild ENIGMA QC assets' }),
    ).toBeDisabled()
    expect(
      within(enigma).queryByRole('button', { name: /^Get it/ }),
    ).not.toBeInTheDocument()
  })

  it('authorizes the offline rebuild once and reports its progress in the card', async () => {
    const api = getApi()
    const check = vi.spyOn(api.env, 'check')
    const authorize = vi.spyOn(api.execution, 'authorize')
    const install = mockInstall()
    renderScreen(
      <DiagnosticsScreen
        report={OFFLINE_REBUILD_REPORT}
        safeExecution={true}
      />,
    )
    const card = await screen.findByRole('region', {
      name: 'Rebuild the scientific assets',
    })
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Rebuild the scientific assets',
      }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm the rebuild of Reviewed scientific assets',
    })
    expect(dialog).toHaveTextContent(/downloads nothing/)
    expect(install.start).not.toHaveBeenCalled()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Authorize rebuild' }),
    )
    await waitFor(() =>
      expect(install.start).toHaveBeenCalledWith(
        expect.objectContaining({ checkId: 'scientific_assets' }),
      ),
    )
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'opt-in-install' }),
    )

    install.publish(installState('scientific_assets'))
    // The card owns the progress; the row does not announce it a second time.
    expect(
      screen.getAllByText(
        'Rebuilding Reviewed scientific assets from the verified files on this machine.',
      ),
    ).toHaveLength(1)
    expect(
      within(card).getByText(
        'Rebuilding Reviewed scientific assets from the verified files on this machine.',
      ),
    ).toBeInTheDocument()
    expect(
      within(card).getByRole('button', {
        name: 'Rebuild the scientific assets',
      }),
    ).toHaveTextContent('Rebuilding assets...')

    install.publish(installState('scientific_assets', { phase: 'done', rc: 0 }))
    await waitFor(() => expect(check).toHaveBeenCalledOnce())
    expect(
      within(card).getByText('Rebuilt Reviewed scientific assets.'),
    ).toBeInTheDocument()
  })

  it('offers the save the rebuild needs once Allow live runs is on', async () => {
    const saveSpy = vi.spyOn(getApi().project, 'save')
    renderScreen(
      <RevisionHarness>
        <DiagnosticsScreen
          report={OFFLINE_REBUILD_REPORT}
          safeExecution={true}
        />
      </RevisionHarness>,
    )
    await screen.findByRole('region', { name: 'Rebuild the scientific assets' })
    fireEvent.click(screen.getByRole('button', { name: 'Revise config' }))
    const card = screen.getByRole('region', {
      name: 'Rebuild the scientific assets',
    })
    expect(
      within(card).getByText(
        'Save the project to rebuild the scientific assets.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Save the project to rebuild the scientific assets',
      }),
    )
    await waitFor(() => expect(saveSpy).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('region', { name: 'Rebuild the scientific assets' }),
        ).getByRole('button', { name: 'Rebuild the scientific assets' }),
      ).toBeEnabled(),
    )
  })

  it('keeps a first acquisition that must download on its row', async () => {
    const report: EnvReport = structuredClone(OFFLINE_REBUILD_REPORT)
    for (const entry of report.groups[0]!.checks) {
      delete entry.offlineInstall
      if (entry.id === 'scientific_assets') {
        entry.downloadUrl = 'https://github.com/ortizo-117/SCI_Map'
      }
    }
    renderScreen(<DiagnosticsScreen report={report} safeExecution={true} />)
    await findCallout()
    expect(
      screen.queryByRole('region', { name: 'Rebuild the scientific assets' }),
    ).not.toBeInTheDocument()
    expect(
      within(envRow('scientific_assets')).getByRole('button', {
        name: 'Install Reviewed scientific assets',
      }),
    ).toBeEnabled()
  })

  it('states the Allow live runs refusal on the row with the control that enables it', async () => {
    const onSafeExecutionChange = vi.fn()
    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={false}
        onSafeExecutionChange={onSafeExecutionChange}
      />,
    )
    await findCallout()
    const row = envRow('rscript')
    expect(
      within(row).getByRole('button', { name: 'Install Rscript' }),
    ).toBeDisabled()
    expect(
      within(row).getByText('Allow live runs to install Rscript.'),
    ).toBeInTheDocument()
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Allow live runs to install Rscript',
      }),
    )
    expect(onSafeExecutionChange).toHaveBeenCalledWith(true)
  })

  it('should render the grouped checks when the report loads', async () => {
    renderScreen(<DiagnosticsScreen />)
    expect(await screen.findByText('PyBrainAge model')).toBeInTheDocument()
    expect(screen.queryByText('FREESURFER_HOME')).not.toBeInTheDocument()
    expandGroup('FreeSurfer')
    expect(screen.getByText('FREESURFER_HOME')).toBeInTheDocument()
  })

  it('should collapse all-green groups by default and expand failing ones', async () => {
    renderScreen(<DiagnosticsScreen />)
    await findLoaded()
    const fsButton = screen.getByRole('button', {
      name: /FreeSurfer.*required, all found/i,
    })
    expect(fsButton).toHaveAttribute('aria-expanded', 'false')
    const rButton = screen.getByRole('button', { name: /^R\b.*issue/i })
    expect(rButton).toHaveAttribute('aria-expanded', 'true')
  })

  it('should surface the top failing check in the Recommended-fix callout', async () => {
    renderScreen(<DiagnosticsScreen />)
    const callout = await findCallout()
    expect(callout).toHaveTextContent(/R Markdown package/)
    // The callout names the blocked step once, in one sentence.
    expect(callout).toHaveTextContent('Needed for the R analysis report.')
    expect(callout.textContent?.match(/R analysis report/g)).toHaveLength(1)
    expect(callout).not.toHaveTextContent(/Resolve this check/)
  })

  it('should not recommend report-only or unselected checks when they are not required', async () => {
    const noReport = structuredClone(DIAGNOSTICS_CONFIG)
    noReport.steps.final.params['renderReport'] = false
    renderScreen(<DiagnosticsScreen cfg={noReport} />)

    const callout = await findCallout()
    expect(callout).toHaveTextContent(/Pinned PyBrainAge runtime/)
    expect(callout).not.toHaveTextContent(/R Markdown package/)
    expect(callout).not.toHaveTextContent(/fsl_deface/)
    expect(callout).not.toHaveTextContent(/^R packages$/)
  })

  it('leaves a disabled stage out of the status, counts, and install plan', async () => {
    // Keep only FreeSurfer reconstruction; the mock host satisfies it.
    const reconOnly = structuredClone(DIAGNOSTICS_CONFIG)
    for (const key of STEP_KEYS) reconOnly.steps[key].enabled = key === 'recon'
    renderScreen(<DiagnosticsScreen cfg={reconOnly} />)

    expect(
      await screen.findByText('The environment is ready.'),
    ).toBeInTheDocument()
    // The ready banner states the fact, not an order.
    expect(screen.queryByText(/Continue because/)).toBeNull()
    expect(screen.queryByText(/^Confirm that/)).toBeNull()
    expect(
      screen.queryByRole('region', { name: 'Recommended fix' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getAllByText('All required dependencies satisfied').length,
    ).toBeGreaterThan(0)
    expect(
      screen.getByRole('button', { name: /^R\b.*none required/i }),
    ).toBeInTheDocument()

    // An empty plan is never offered as a script, and the disabled action's
    // tooltip says that nothing remains to install.
    const copyPlan = screen.getByRole('button', { name: 'Copy install plan' })
    expect(copyPlan).toBeDisabled()
    expect(copyPlan).toHaveAttribute(
      'title',
      'Every dependency is already satisfied, so the install plan is empty.',
    )
    fireEvent.click(copyPlan)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('keeps the ready banner hint above the contrast minimum', async () => {
    // The dim hint color measures 4.25:1 on the tinted success background.
    const reconOnly = structuredClone(DIAGNOSTICS_CONFIG)
    for (const key of STEP_KEYS) reconOnly.steps[key].enabled = key === 'recon'
    renderScreen(<DiagnosticsScreen cfg={reconOnly} />)

    await screen.findByText('The environment is ready.')
    const hint = screen.getByText(
      /Every required pipeline tool is detected and usable\./,
    )
    expect(hint).toHaveStyle({ color: THEMES.light.text })
  })

  it('marks the unused reconstruction binary as not needed under FastSurfer', async () => {
    const fastsurfer = structuredClone(DIAGNOSTICS_CONFIG)
    fastsurfer.steps.recon.params['backend'] = 'fastsurfer'
    const api = getApi()
    vi.spyOn(api.env, 'check').mockResolvedValue({
      capturedAt: '2026-01-01T00:00:00.000Z',
      availableMemoryGB: 24,
      groups: [
        {
          name: 'FreeSurfer',
          checks: [
            { id: 'reconall', label: 'recon-all', status: 'missing' },
            { id: 'license', label: 'License file', status: 'found' },
          ],
        },
      ],
    })
    renderScreen(<DiagnosticsScreen cfg={fastsurfer} />)

    expect(
      await screen.findByText('The environment is ready.'),
    ).toBeInTheDocument()
    expandGroup('FreeSurfer', 'required, all found')
    const row = envRow('reconall')
    expect(
      within(row).getByText('Not needed for this pipeline'),
    ).toBeInTheDocument()
    expect(within(row).queryByText(/Needed for:/)).not.toBeInTheDocument()
  })

  it('marks an unselected defacing tool as not needed', async () => {
    const defacing = structuredClone(DIAGNOSTICS_CONFIG)
    defacing.steps.deface.enabled = true
    defacing.steps.deface.params['tool'] = 'mri_deface'
    const api = getApi()
    vi.spyOn(api.env, 'check').mockResolvedValue({
      capturedAt: '2026-01-01T00:00:00.000Z',
      availableMemoryGB: 24,
      groups: [
        {
          name: 'Defacing',
          checks: [
            { id: 'mri_deface', label: 'mri_deface', status: 'found' },
            {
              id: 'mri_deface_templates',
              label: 'mri_deface GCA templates',
              status: 'found',
            },
            { id: 'pydeface', label: 'pydeface', status: 'missing' },
          ],
        },
      ],
    })
    renderScreen(<DiagnosticsScreen cfg={defacing} />)

    expect(
      await screen.findByText('The environment is ready.'),
    ).toBeInTheDocument()
    expandGroup('Defacing', '3 checks, 2 required, all found')
    const row = envRow('pydeface')
    expect(
      within(row).getByText('Not needed for this pipeline'),
    ).toBeInTheDocument()
    // The row keeps a truthful verdict, in the neutral tone of a check that
    // blocks nothing.
    expect(within(row).getByText('Not installed')).toBeInTheDocument()
    expect(within(row).queryByText('Missing')).toBeNull()
  })

  it('should show the all-satisfied banner and no callout when nothing fails', async () => {
    const api = getApi()
    const spy = vi.spyOn(api.env, 'check').mockResolvedValue({
      capturedAt: '2026-01-01T00:00:00.000Z',
      availableMemoryGB: 24,
      groups: [
        {
          name: 'FreeSurfer',
          checks: [{ id: 'fshome', label: 'FREESURFER_HOME', status: 'found' }],
        },
      ],
    })
    renderScreen(<DiagnosticsScreen />)
    expect(
      await screen.findByText('The environment is ready.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'Recommended fix' }),
    ).not.toBeInTheDocument()
    spy.mockRestore()
  })

  it('states that a report has no checks and keeps Re-check as the remedy', async () => {
    const api = getApi()
    const spy = vi.spyOn(api.env, 'check').mockResolvedValue({
      capturedAt: '2026-01-01T00:00:00.000Z',
      availableMemoryGB: 24,
      groups: [],
    })
    renderScreen(<DiagnosticsScreen />)
    expect(
      await screen.findByText(
        'No checks were reported for this configuration.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^Run Diagnostics again/)).toBeNull()
    // The header chip states the same fact instead of claiming success.
    expect(screen.getByText('No checks reported')).toBeInTheDocument()
    expect(screen.queryByText('All required dependencies satisfied')).toBeNull()
    const calls = spy.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }))
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(calls))
    spy.mockRestore()
  })

  it('should scope the checks to one group when its summary tile is pressed', async () => {
    renderScreen(<DiagnosticsScreen />)
    await findLoaded()
    expect(screen.queryByText('FREESURFER_HOME')).not.toBeInTheDocument()

    const tile = screen.getByRole('button', { name: /Show only FreeSurfer/i })
    fireEvent.click(tile)

    expect(tile).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('FREESURFER_HOME')).toBeInTheDocument()
    expect(screen.queryByText('PyBrainAge model')).not.toBeInTheDocument()

    const activeTile = screen.getByRole('button', {
      name: /Clear filter \(FreeSurfer\)/i,
    })
    fireEvent.click(activeTile)
    expect(activeTile).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('PyBrainAge model')).toBeInTheDocument()
  })

  it('should surface the unblocked pipeline step on a failing required row', async () => {
    renderScreen(<DiagnosticsScreen />)
    await findLoaded()
    const rows = await screen.findAllByRole('listitem')
    const text = rows.map((r) => r.textContent ?? '')
    expect(
      text.some((txt) => /Needed for: the R analysis report/.test(txt)),
    ).toBe(true)
    // The advisory R package row gates no stage, so it claims none.
    const rpkgs = text.find((txt) => txt.includes('Optional R packages'))
    expect(rpkgs).toBeDefined()
    expect(rpkgs).not.toMatch(/Needed for:/)
    expect(rpkgs).toContain('Optional')
  })

  it('should disable Install when safe execution is off', async () => {
    renderScreen(<DiagnosticsScreen safeExecution={false} />)
    await findLoaded()
    const installButtons = screen.getAllByRole('button', {
      name: /^Install (?!the missing dependency)/,
    })
    expect(installButtons.length).toBeGreaterThan(0)
    for (const btn of installButtons) {
      expect(btn).toBeDisabled()
    }
  })

  it('routes the callout to the owning row, whose Install stays gated', async () => {
    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={false}
      />,
    )
    const callout = await findCallout()
    expect(
      within(callout).queryByRole('button', { name: /^Install / }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      within(callout).getByRole('button', { name: 'Go to the Rscript check' }),
    )
    const row = envRow('rscript')
    await waitFor(() => expect(row).toHaveFocus())
    expect(
      within(row).getByRole('button', { name: 'Install Rscript' }),
    ).toBeDisabled()
    expect(within(row).getByText(/^Needs live runs$/)).toBeInTheDocument()
  })

  it('clears a foreign group filter when jumping to the recommended check', async () => {
    const report: EnvReport = {
      capturedAt: '2026-01-01T00:00:00.000Z',
      availableMemoryGB: 24,
      groups: [
        ...INSTALLABLE_REQUIRED_REPORT.groups,
        {
          name: 'Shell utilities',
          checks: [{ id: 'bash', label: 'bash', status: 'found' }],
        },
      ],
    }
    renderScreen(<DiagnosticsScreen report={report} safeExecution={false} />)
    const callout = await findCallout()

    fireEvent.click(
      screen.getByRole('button', { name: 'Show only Shell utilities' }),
    )
    expect(document.getElementById('env-check-rscript')).toBeNull()

    fireEvent.click(
      within(callout).getByRole('button', { name: 'Go to the Rscript check' }),
    )
    const row = envRow('rscript')
    await waitFor(() => expect(row).toHaveFocus())
  })

  it('keeps the row Install enabled under Allow live runs without a callout duplicate', async () => {
    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={true}
      />,
    )
    const callout = await findCallout()
    expect(
      within(callout).queryByRole('button', { name: /^Install / }),
    ).not.toBeInTheDocument()
    expect(
      within(envRow('rscript')).getByRole('button', {
        name: 'Install Rscript',
      }),
    ).toBeEnabled()
  })

  it('shows manual system installers as copy-only terminal fixes on the row', async () => {
    const mcrCfg = structuredClone(DIAGNOSTICS_CONFIG)
    mcrCfg.steps.enigma.params['backend'] = 'mcr'
    renderScreen(
      <DiagnosticsScreen
        cfg={mcrCfg}
        report={MANUAL_REQUIRED_REPORT}
        safeExecution={true}
      />,
    )

    const callout = await findCallout()
    expect(
      within(callout).queryByText(/this reviewed command runs in a terminal/i),
    ).not.toBeInTheDocument()
    const row = envRow('mcr')
    expect(
      within(row).getByText(/this reviewed command runs in a terminal/i),
    ).toBeInTheDocument()
    expect(
      within(row).getByRole('button', { name: 'Copy fix for MATLAB Runtime' }),
    ).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'Install MATLAB Runtime' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/^Needs live runs$/)).not.toBeInTheDocument()
  })

  it('should state the Allow live runs gate as visible text, not only a tooltip', async () => {
    renderScreen(<DiagnosticsScreen safeExecution={false} />)
    await findLoaded()
    expect(screen.getByText('Allow live runs: off')).toHaveAttribute(
      'title',
      'Installs from this screen need Allow live runs, and each one asks first.',
    )
    expect(screen.getAllByText(/^Needs live runs$/).length).toBeGreaterThan(0)
  })

  it('reports Allow live runs as on once it is enabled', async () => {
    renderScreen(<DiagnosticsScreen safeExecution />)
    await findLoaded()
    expect(screen.getByText('Allow live runs: on')).toBeInTheDocument()
    expect(screen.queryByText('Allow live runs: off')).not.toBeInTheDocument()
  })

  it('presents only the selected MCR backend as required and reads ready', async () => {
    renderScreen(<DiagnosticsScreen report={MCR_SELECTED_REPORT} />)

    await screen.findByRole('button', {
      name: /MATLAB \/ MATLAB Runtime.*required, all found/i,
    })
    expect(
      screen.queryByRole('region', { name: 'Recommended fix' }),
    ).not.toBeInTheDocument()

    expandGroup('MATLAB / MATLAB Runtime')
    const group = screen.getByRole('list')
    expect(
      within(group).getByText(/MATLAB \(optional source backend\)/),
    ).toBeInTheDocument()
    expect(
      within(group).getByText(
        /MATLAB Runtime runs ENIGMA QC because source MATLAB is neither on PATH nor configured\./,
      ),
    ).toBeInTheDocument()
    expect(within(group).queryByText('missing')).not.toBeInTheDocument()
  })

  it('shows backend selection and readiness in the ENIGMA QC configuration card', async () => {
    renderScreen(<DiagnosticsScreen report={MATLAB_SELECTED_MISSING_REPORT} />)

    const card = await screen.findByRole('group', {
      name: 'ENIGMA QC backend selection and readiness',
    })
    expect(
      within(card).getByText('Source MATLAB (selected): not ready'),
    ).toBeInTheDocument()
    expect(
      within(card).getByText('MATLAB Runtime: not ready'),
    ).toBeInTheDocument()
  })

  it('leaves the automatic backend unselected until a report resolves it', async () => {
    const api = getApi()
    const pending = deferred<EnvReport>()
    vi.spyOn(api.env, 'check').mockReturnValue(pending.promise)
    renderScreen(<DiagnosticsScreen />)

    const card = await screen.findByRole('group', {
      name: 'ENIGMA QC backend selection and readiness',
    })
    expect(
      within(card).getByText('Selected backend: auto (not checked yet)'),
    ).toBeInTheDocument()
    expect(
      within(card).getByText('Source MATLAB: not checked'),
    ).toBeInTheDocument()
    expect(
      within(card).getByText('MATLAB Runtime: not checked'),
    ).toBeInTheDocument()
    expect(within(card).queryByText(/\(selected\)/)).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve(MCR_SELECTED_REPORT)
      await Promise.resolve()
    })
    const resolved = await screen.findByRole('group', {
      name: 'ENIGMA QC backend selection and readiness',
    })
    expect(
      within(resolved).getByText(
        'Selected backend: auto, resolves to MATLAB Runtime',
      ),
    ).toBeInTheDocument()
    expect(
      within(resolved).getByText('MATLAB Runtime (selected): ready'),
    ).toBeInTheDocument()
    expect(
      within(resolved).getByText('Source MATLAB: not ready'),
    ).toBeInTheDocument()
  })

  it('marks the pinned ENIGMA backend before the first check completes', async () => {
    const api = getApi()
    const pending = deferred<EnvReport>()
    vi.spyOn(api.env, 'check').mockReturnValue(pending.promise)
    renderScreen(<DiagnosticsScreen cfg={mcrBackendConfig()} />)

    const card = await screen.findByRole('group', {
      name: 'ENIGMA QC backend selection and readiness',
    })
    expect(
      within(card).getByText('Selected backend: MATLAB Runtime'),
    ).toBeInTheDocument()
    expect(
      within(card).getByText('MATLAB Runtime (selected): not checked'),
    ).toBeInTheDocument()
    expect(
      within(card).getByText('Source MATLAB: not checked'),
    ).toBeInTheDocument()
  })

  it('names the detected MATLAB Runtime while the root parameter is blank', async () => {
    renderScreen(<DiagnosticsScreen report={MCR_SELECTED_REPORT} />)

    const field = await screen.findByRole('group', {
      name: 'MATLAB Runtime root configuration',
    })
    expect(
      within(field).getByText(
        'Detected at /usr/local/MATLAB/MATLAB_Runtime/v97 (R2019b)',
      ),
    ).toBeInTheDocument()
    expect(within(field).queryByText('Not configured')).not.toBeInTheDocument()
    expect(
      within(field).getByRole('button', {
        name: 'Choose Runtime root for ENIGMA QC',
      }),
    ).toBeInTheDocument()
  })

  it('names a detected MATLAB Runtime whose report carries no path', async () => {
    renderScreen(<DiagnosticsScreen report={PATHLESS_MCR_REPORT} />)

    const field = await screen.findByRole('group', {
      name: 'MATLAB Runtime root configuration',
    })
    expect(
      within(field).getByText('Detected (default location)'),
    ).toBeInTheDocument()
  })

  it('counts a group identically in the summary tile and the group header', async () => {
    renderScreen(<DiagnosticsScreen report={MCR_SELECTED_REPORT} />)

    const tile = await screen.findByRole('button', {
      name: 'Show only MATLAB / MATLAB Runtime',
    })
    // Both panels name the total and how much of it the pipeline requires.
    const countsElement = within(tile).getByText(/checks,/)
    const counts = countsElement.textContent ?? ''
    expect(counts).toBe('3 checks, 1 required')
    // The counts keep to one line of their own below the rollup, so a short
    // rollup leaves no blank line in its tile.
    expect(countsElement.style.whiteSpace).toBe('nowrap')
    expect(countsElement.style.display).toBe('block')
    const rollup = countsElement.previousElementSibling as HTMLElement
    expect(rollup.style.display).toBe('block')
    expect(rollup.textContent).not.toBe('')
    expect(
      screen.getByRole('button', { name: new RegExp(`${counts}, all found`) }),
    ).toBeInTheDocument()
  })

  it('reports an undetected MATLAB Runtime as not configured', async () => {
    renderScreen(<DiagnosticsScreen report={MATLAB_SELECTED_MISSING_REPORT} />)

    const field = await screen.findByRole('group', {
      name: 'MATLAB Runtime root configuration',
    })
    expect(within(field).getByText('Not configured')).toBeInTheDocument()
  })

  it('chooses the MATLAB executable and Runtime root through the native pickers', async () => {
    const api = getApi()
    const chooseFile = vi
      .spyOn(api.fs, 'chooseFile')
      .mockResolvedValue('/opt/matlab/bin/matlab')
    const chooseDir = vi
      .spyOn(api.fs, 'chooseDir')
      .mockResolvedValue('/usr/local/MATLAB/MATLAB_Runtime/v97')
    renderScreen(
      <>
        <DiagnosticsScreen report={EMPTY_REPORT} />
        <EnigmaConfigProbe />
      </>,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Choose MATLAB executable for ENIGMA QC',
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('enigma-config-probe')).toHaveTextContent(
        'dirty:/opt/matlab/bin/matlab:(none)',
      ),
    )
    expect(chooseFile).toHaveBeenCalledWith({})

    fireEvent.click(
      screen.getByRole('button', { name: 'Choose Runtime root for ENIGMA QC' }),
    )
    await waitFor(() =>
      expect(screen.getByTestId('enigma-config-probe')).toHaveTextContent(
        'dirty:/opt/matlab/bin/matlab:/usr/local/MATLAB/MATLAB_Runtime/v97',
      ),
    )
    expect(chooseDir).toHaveBeenCalledWith({})
    expect(
      within(
        screen.getByRole('group', { name: 'MATLAB executable configuration' }),
      ).getByText('Configured'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Replace MATLAB executable for ENIGMA QC',
      }),
    ).toHaveTextContent(/^Replace\.\.\.$/)
    expect(
      within(
        screen.getByRole('group', {
          name: 'MATLAB Runtime root configuration',
        }),
      ).getByText('Configured'),
    ).toBeInTheDocument()
  })

  it('keeps the license-free MCR route visible on the skipped alternative row', async () => {
    renderScreen(<DiagnosticsScreen report={MATLAB_SELECTED_MISSING_REPORT} />)

    // The failing group is expanded by default; the skipped alternative keeps
    // its copyable command, download link, and switch guidance.
    const list = await screen.findByRole('list')
    expect(
      within(list).getByText('MATLAB Runtime (optional compiled backend)'),
    ).toBeInTheDocument()
    expect(within(list).getByText(MCR_ONE_LINER)).toBeInTheDocument()
    expect(
      within(list).getByText(
        /selecting the mcr backend in the ENIGMA QC step options; the compiled route requires the R2019b \(9\.7\) MATLAB Runtime and the verified compiled ENIGMA assets\./,
      ),
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('button', {
        name: 'Copy fix for MATLAB Runtime (optional compiled backend)',
      }),
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('button', {
        name: 'Get it: open the download page for MATLAB Runtime (optional compiled backend)',
      }),
    ).toBeInTheDocument()
    // Keep the sudo installer out of in-app execution and the install plan.
    expect(
      within(list).queryByRole('button', { name: /^Install / }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy install plan' }),
    ).toBeDisabled()
  })

  it('installs a missing report package through the existing opt-in gate', async () => {
    const api = getApi()
    const check = vi.spyOn(api.env, 'check')
    const install = mockInstall()

    renderScreen(
      <DiagnosticsScreen report={R_SETUP_REPORT} safeExecution={true} />,
    )
    const list = await screen.findByRole('list')
    expect(within(list).getByText(RMARKDOWN_INSTALL_CMD)).toBeInTheDocument()
    fireEvent.click(
      within(list).getByRole('button', { name: 'Install R Markdown' }),
    )

    expect(install.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))
    await waitFor(() =>
      expect(install.start).toHaveBeenCalledWith(
        expect.objectContaining({ checkId: 'rmarkdown' }),
      ),
    )
    expect(check).not.toHaveBeenCalled()

    install.publish(
      installState('rmarkdown', {
        phase: 'done',
        rc: 0,
        stdout: 'installed rmarkdown',
      }),
    )
    // The existing reprobe reflects the user-space install without a restart.
    await waitFor(() => expect(check).toHaveBeenCalledOnce())
  })

  it('keeps R and Pandoc system installs copy-only with official links', async () => {
    const api = getApi()
    const openWeb = vi.spyOn(api.external, 'openWeb').mockResolvedValue()
    renderScreen(<DiagnosticsScreen report={R_SETUP_REPORT} />)

    const list = await screen.findByRole('list')
    expect(
      within(list).getByText('sudo apt-get install r-base'),
    ).toBeInTheDocument()
    expect(
      within(list).getByText('sudo apt-get install pandoc'),
    ).toBeInTheDocument()
    // The system rows stay copy-only: no in-app Install, terminal hint shown.
    expect(
      within(list).queryByRole('button', { name: 'Install Rscript' }),
    ).not.toBeInTheDocument()
    expect(
      within(list).queryByRole('button', { name: 'Install Pandoc' }),
    ).not.toBeInTheDocument()
    expect(
      within(list).getAllByText(
        /This reviewed command runs in a terminal, outside Supraspina/,
      ).length,
    ).toBeGreaterThan(0)

    fireEvent.click(
      within(list).getByRole('button', {
        name: 'Get it: open the download page for Pandoc',
      }),
    )
    expect(openWeb).toHaveBeenCalledWith({
      url: 'https://pandoc.org/installing.html',
      purpose: 'download',
    })

    // The copyable plan stays valid standalone bash with every failing fix.
    fireEvent.click(screen.getByRole('button', { name: 'Copy install plan' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1),
    )
    const plan = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as string
    expect(plan).toContain('set -euo pipefail')
    expect(plan.split('\n')).toContain('sudo apt-get install r-base')
    expect(plan.split('\n')).toContain('sudo apt-get install pandoc')
    expect(plan.split('\n')).toContain(RMARKDOWN_INSTALL_CMD)
  })

  it('opens the official MATLAB page from the missing MATLAB row', async () => {
    const api = getApi()
    const openWeb = vi.spyOn(api.external, 'openWeb').mockResolvedValue()
    renderScreen(<DiagnosticsScreen report={MATLAB_SELECTED_MISSING_REPORT} />)

    const callout = await findCallout()
    expect(within(callout).getByText('MATLAB')).toBeInTheDocument()
    fireEvent.click(
      within(envRow('matlab')).getByRole('button', {
        name: 'Get it: open the download page for MATLAB',
      }),
    )
    expect(openWeb).toHaveBeenCalledWith({
      url: 'https://www.mathworks.com/products/matlab.html',
      purpose: 'download',
    })
  })

  it('should show a plain-language "what is this" line per known check', async () => {
    renderScreen(<DiagnosticsScreen />)
    await findLoaded()
    expandGroup('FreeSurfer')
    expect(
      screen.getByText(
        /The FreeSurfer installation location in FREESURFER_HOME, which reconstruction needs\./i,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Octave/i)).not.toBeInTheDocument()
  })

  it('should call optInInstall only after themed confirmation when safe execution is on', async () => {
    const install = mockInstall()
    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={true}
      />,
    )
    await findLoaded()

    const installButtons = screen.getAllByRole('button', { name: /^Install / })
    const first = installButtons[0]
    if (!first) throw new Error('Render an install button.')
    expect(first).not.toBeDisabled()
    fireEvent.click(first)

    expect(install.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))
    await waitFor(() => expect(install.start).toHaveBeenCalledTimes(1))
    install.publish(installState('rscript', { phase: 'done', rc: 0 }))
    expect((await screen.findAllByText('rc=0')).length).toBeGreaterThan(0)
  })

  it('reports the running installation with its check and elapsed time', async () => {
    const install = mockInstall()
    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={true}
      />,
    )
    await findCallout()
    const row = envRow('rscript')
    fireEvent.click(
      within(row).getByRole('button', { name: 'Install Rscript' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))

    // The row reports the operation before the sidecar answers, so the action
    // never looks idle while an installer holds the host.
    expect(
      await within(row).findByText('Running package installation for Rscript.'),
    ).toBeInTheDocument()
    expect(within(row).getByText('00:00')).toBeInTheDocument()
    expect(within(row).getByText('Starting')).toBeInTheDocument()
    expect(
      within(row).getByRole('button', { name: 'Install Rscript' }),
    ).toBeDisabled()
    // No installer reports a percentage, so the app never invents one.
    expect(row).not.toHaveTextContent('%')

    install.publish(
      installState('rscript', {
        phase: 'running',
        output: 'Collecting dplyr\n',
      }),
    )
    expect(within(row).getByText('Running')).toBeInTheDocument()
    expect(within(row).getByText(/Collecting dplyr/)).toBeInTheDocument()
    expect(row).not.toHaveTextContent('%')
  })

  it('installs the top fix from its owning row with a real outcome', async () => {
    const api = getApi()
    const check = vi.spyOn(api.env, 'check')
    const install = mockInstall()

    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={true}
      />,
    )
    await findCallout()
    const row = envRow('rscript')
    fireEvent.click(
      within(row).getByRole('button', { name: 'Install Rscript' }),
    )

    expect(install.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))
    await waitFor(() =>
      expect(install.start).toHaveBeenCalledWith(
        expect.objectContaining({ checkId: 'rscript' }),
      ),
    )
    install.publish(
      installState('rscript', {
        phase: 'done',
        rc: 0,
        stdout: 'installed Rscript',
      }),
    )
    await waitFor(() => expect(check).toHaveBeenCalledOnce())
    expect(within(row).getByText('rc=0')).toBeInTheDocument()
    expect(within(row).getByText('Installed Rscript.')).toBeInTheDocument()
    expect(within(row).getByText('installed Rscript')).toBeInTheDocument()
  })

  it('should preserve a failed install outcome without re-checking', async () => {
    const api = getApi()
    const check = vi.spyOn(api.env, 'check')
    const install = mockInstall()
    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={true}
      />,
    )

    await findCallout()
    const row = envRow('rscript')
    fireEvent.click(
      within(row).getByRole('button', { name: 'Install Rscript' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))
    install.publish(
      installState('rscript', {
        phase: 'error',
        rc: 7,
        stderr: 'Retry acquisition because verification failed.',
      }),
    )

    expect(
      await within(row).findByText('The installation of Rscript failed.'),
    ).toBeInTheDocument()
    expect(within(row).getByText('rc=7')).toBeInTheDocument()
    expect(row).toHaveTextContent(
      'Retry acquisition because verification failed.',
    )
    expect(check).not.toHaveBeenCalled()
    // A settled failure frees the action for another attempt.
    expect(
      within(row).getByRole('button', { name: 'Install Rscript' }),
    ).toBeEnabled()
  })

  it('should not call optInInstall when the user cancels the themed confirmation', async () => {
    const api = getApi()
    const spy = vi.spyOn(api.env, 'optInInstall')

    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={true}
      />,
    )
    await findLoaded()

    const first = screen.getAllByRole('button', { name: /^Install / })[0]
    if (!first) throw new Error('Render an install button.')
    fireEvent.click(first)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(spy).not.toHaveBeenCalled()

    spy.mockRestore()
  })

  it('offers a copyable command and a gated create action on the warn row', async () => {
    renderScreen(
      <DiagnosticsScreen report={SUBJDIR_WARN_REPORT} safeExecution={false} />,
    )
    expandAdvisoryFreesurferGroup()

    const create = await screen.findByRole('button', {
      name: 'Create directory for SUBJECTS_DIR',
    })
    expect(create).toBeDisabled()
    expect(screen.getByText('Needs live runs')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy fix for SUBJECTS_DIR' }),
    ).toBeInTheDocument()
    expect(screen.getByText(SUBJDIR_MKDIR_CMD)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Install / }),
    ).not.toBeInTheDocument()
  })

  it('creates the directory only after themed confirmation and reprobes', async () => {
    const api = getApi()
    const check = vi.spyOn(api.env, 'check')
    const authorize = vi.spyOn(api.execution, 'authorize')
    const spy = vi.spyOn(api.env, 'createOutputDir').mockResolvedValue({
      ok: true,
      detail: 'Created /data/deri vatives/freesurfer.',
    })
    renderScreen(
      <DiagnosticsScreen report={SUBJDIR_WARN_REPORT} safeExecution={true} />,
    )
    expandAdvisoryFreesurferGroup()

    const create = await screen.findByRole('button', {
      name: 'Create directory for SUBJECTS_DIR',
    })
    expect(create).not.toBeDisabled()
    fireEvent.click(create)
    expect(spy).not.toHaveBeenCalled()
    expect(
      screen.getByText('Confirm directory creation for SUBJECTS_DIR'),
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Authorize directory creation' }),
    )
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'opt-in-install' }),
    )
    const request = spy.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(Object.keys(request).sort()).toEqual([
      'authorization',
      'cfg',
      'checkId',
      'configRevision',
      'project',
    ])
    expect(request.checkId).toBe('subjdir')
    await waitFor(() => expect(check).toHaveBeenCalledOnce())
    const outcome = await screen.findByText(
      'Created /data/deri vatives/freesurfer.',
    )
    expect(outcome).toHaveRole('status')

    spy.mockRestore()
  })

  it('preserves a create-directory refusal without re-checking', async () => {
    const api = getApi()
    const check = vi.spyOn(api.env, 'check')
    vi.spyOn(api.env, 'createOutputDir').mockResolvedValue({
      ok: false,
      detail: 'Replace /data/deri vatives/freesurfer with a directory.',
    })
    renderScreen(
      <DiagnosticsScreen report={SUBJDIR_WARN_REPORT} safeExecution={true} />,
    )
    expandAdvisoryFreesurferGroup()

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Create directory for SUBJECTS_DIR',
      }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Authorize directory creation' }),
    )

    const outcome = await screen.findByText(
      'Replace /data/deri vatives/freesurfer with a directory.',
    )
    expect(outcome).toHaveRole('status')
    expect(check).not.toHaveBeenCalled()
  })

  it('does not call createOutputDir when the user cancels the confirmation', async () => {
    const api = getApi()
    const spy = vi.spyOn(api.env, 'createOutputDir')
    renderScreen(
      <DiagnosticsScreen report={SUBJDIR_WARN_REPORT} safeExecution={true} />,
    )
    expandAdvisoryFreesurferGroup()

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Create directory for SUBJECTS_DIR',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(spy).not.toHaveBeenCalled()

    spy.mockRestore()
  })

  it('keeps the advisory directory command on its row and out of the plan', async () => {
    renderScreen(
      <DiagnosticsScreen report={SUBJDIR_WARN_REPORT} safeExecution={false} />,
    )
    expandAdvisoryFreesurferGroup()
    await screen.findByRole('button', {
      name: 'Create directory for SUBJECTS_DIR',
    })

    // No stage gate names the directory check, so its command stays on the row
    // it belongs to and never reaches the plan, which stays empty.
    expect(screen.getByText(SUBJDIR_MKDIR_CMD)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Copy install plan' }),
    ).toBeDisabled()
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('keeps a quoted required command verbatim in the copied install plan', async () => {
    renderScreen(
      <DiagnosticsScreen
        report={QUOTED_REQUIRED_REPORT}
        safeExecution={false}
      />,
    )
    await findCallout()

    fireEvent.click(screen.getByRole('button', { name: 'Copy install plan' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1),
    )
    const plan = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as string
    expect(plan.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(plan).toContain('set -euo pipefail')
    expect(plan.split('\n')).toContain(SUBJDIR_MKDIR_CMD)
  })

  it('routes the typed PyBrainAge row action to the shared setup flow', async () => {
    const api = getApi()
    const authorize = vi.spyOn(api.execution, 'authorize')
    const provision = vi
      .spyOn(api.provision, 'pybrainage')
      .mockResolvedValue({ operationId: 'provision-row' })
    renderScreen(
      <DiagnosticsScreen
        report={PYBRAINAGE_ACTION_REPORT}
        safeExecution={true}
      />,
    )

    const label = await screen.findByText('PyBrainAge environment', {
      selector: 'span',
    })
    const row = label.closest('[role="listitem"]') as HTMLElement
    expect(
      within(row).queryByRole('button', { name: /Copy fix/ }),
    ).not.toBeInTheDocument()
    expect(
      within(row).queryByRole('button', { name: /^Install / }),
    ).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('provision.pybrainage')

    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Set up PyBrainAge for PyBrainAge environment',
      }),
    )
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm PyBrainAge setup',
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Authorize setup' }),
    )
    await waitFor(() => expect(provision).toHaveBeenCalledOnce())
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'provision' }),
    )
  })

  it('keeps the provenance link beside the typed action on the model row', async () => {
    const api = getApi()
    const spy = vi.spyOn(api.external, 'openWeb').mockResolvedValue(undefined)
    renderScreen(
      <DiagnosticsScreen
        report={PYBRAINAGE_ACTION_REPORT}
        safeExecution={true}
      />,
    )

    const label = await screen.findByText('PyBrainAge ExtraTrees model', {
      selector: 'span',
    })
    const row = label.closest('[role="listitem"]') as HTMLElement
    expect(row).toHaveTextContent(
      'Get it opens the pinned Zenodo record for provenance review.',
    )
    expect(
      within(row).getByRole('button', {
        name: 'Set up PyBrainAge for PyBrainAge ExtraTrees model',
      }),
    ).toBeInTheDocument()

    fireEvent.click(
      within(row).getByRole('button', {
        name: /Get it: open the download page/i,
      }),
    )
    expect(spy).toHaveBeenCalledWith({
      url: 'https://zenodo.org/records/10406573',
      purpose: 'download',
    })
    spy.mockRestore()
  })

  it('excludes the typed setup rows from the copied install plan', async () => {
    renderScreen(
      <DiagnosticsScreen
        report={PYBRAINAGE_ACTION_REPORT}
        safeExecution={false}
      />,
    )
    // Only the owning row offers the action, and it stays gated.
    const actions = await screen.findAllByRole('button', {
      name: 'Set up PyBrainAge for PyBrainAge environment',
    })
    expect(actions).toHaveLength(1)
    for (const action of actions) expect(action).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Copy install plan' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1),
    )
    const plan = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as string
    expect(plan.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(plan.split('\n')).toContain('install-rscript')
    expect(plan).not.toContain('PyBrainAge')
    expect(plan).not.toContain('provision.pybrainage')
  })

  it('routes the recommended-fix callout to the row that owns the typed setup action', async () => {
    const api = getApi()
    const provision = vi
      .spyOn(api.provision, 'pybrainage')
      .mockResolvedValue({ operationId: 'provision-callout' })
    renderScreen(
      <DiagnosticsScreen
        report={PYBRAINAGE_ACTION_REPORT}
        safeExecution={true}
      />,
    )

    const callout = await findCallout()
    expect(callout).toHaveTextContent('PyBrainAge environment')
    expect(
      within(callout).queryByRole('button', { name: /Copy fix/ }),
    ).not.toBeInTheDocument()
    expect(callout.textContent).not.toContain('provision.pybrainage')

    fireEvent.click(
      within(callout).getByRole('button', {
        name: 'Go to the PyBrainAge environment check',
      }),
    )
    const row = envRow('pyenv')
    await waitFor(() => expect(row).toHaveFocus())
    fireEvent.click(
      within(row).getByRole('button', {
        name: 'Set up PyBrainAge for PyBrainAge environment',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Authorize setup' }))
    await waitFor(() => expect(provision).toHaveBeenCalledOnce())
  })

  it('should copy a per-check fix command to the clipboard', async () => {
    renderScreen(<DiagnosticsScreen />)
    await findLoaded()

    const copyButtons = screen.getAllByRole('button', {
      name: /Copy fix for Optional R packages/i,
    })
    const copyBtn = copyButtons[0]
    if (!copyBtn) throw new Error('Render a copy-fix button.')
    fireEvent.click(copyBtn)

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1),
    )
    const arg = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0]
    expect(String(arg)).toContain('install.packages')
  })

  it('should show a humanized "Last updated" freshness label with the raw ISO in its title', async () => {
    renderScreen(<DiagnosticsScreen />)
    await findLoaded()

    const fresh = screen.getByText(/^Last updated /)
    expect(fresh).toHaveAttribute('aria-live', 'polite')
    expect(fresh.textContent ?? '').not.toMatch(/\dT\d/)
    const raw = fresh.getAttribute('title') ?? ''
    expect(Number.isFinite(new Date(raw).getTime())).toBe(true)
  })

  it('should open a download page through the bridge when Get it is clicked', async () => {
    const api = getApi()
    const spy = vi.spyOn(api.external, 'openWeb').mockResolvedValue(undefined)

    renderScreen(<DiagnosticsScreen />)
    const label = await screen.findByText('PyBrainAge model')
    const row = label.closest('[role="listitem"]')
    if (!row) throw new Error('Render the download row.')

    const getIt = within(row as HTMLElement).getByRole('button', {
      name: /Get it: open the download page/i,
    })
    fireEvent.click(getIt)

    expect(spy).toHaveBeenCalledWith({
      url: 'https://doi.org/10.5281/zenodo.10406573',
      purpose: 'download',
    })
    spy.mockRestore()
  })

  it('provisions PyBrainAge, verifies the final status, and applies pinned paths', async () => {
    const api = getApi()
    const provision = vi.spyOn(api.provision, 'pybrainage')
    const verifiedPython =
      '/projects/diagnostics/outputs/run/.pybrainage/current/envs/pybrainage/bin/python'
    const status = vi.spyOn(api.provision, 'status').mockResolvedValue({
      envReady: true,
      modelReady: true,
      pythonExecutable: verifiedPython,
      modelPath:
        '/projects/diagnostics/outputs/run/.pybrainage/current/pybrainage/v3/software/ExtraTreesModel',
      scalerPath:
        '/projects/diagnostics/outputs/run/.pybrainage/current/pybrainage/v3/software/scaler.pkl',
      projectId: DIAGNOSTICS_PROJECT.projectId,
      projectEpoch: DIAGNOSTICS_PROJECT.epoch,
      configRevision: 0,
      operationId: 'provision-verified',
      phase: 'done',
      cancellable: false,
      error: null,
    })
    const refresh = vi.fn()
    renderScreen(
      <>
        <DiagnosticsScreen
          report={PYBRAINAGE_REPORT}
          safeExecution={true}
          refresh={refresh}
        />
        <ConfigProbe />
      </>,
    )

    const setup = screen.getByRole('button', { name: 'Set up PyBrainAge' })
    fireEvent.click(setup)
    const dialog = screen.getByRole('dialog', {
      name: 'Confirm PyBrainAge setup',
    })
    expect(dialog).toHaveTextContent('108,063,062 bytes')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(
      screen.queryByRole('dialog', { name: 'Confirm PyBrainAge setup' }),
    ).toBeNull()

    fireEvent.click(setup)
    fireEvent.click(screen.getByRole('button', { name: 'Authorize setup' }))
    await waitFor(() => expect(provision).toHaveBeenCalledOnce())
    await waitFor(() => expect(status).toHaveBeenCalledOnce())
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(screen.getByTestId('config-probe')).toHaveTextContent(
      `dirty:${verifiedPython}:`,
    )
  })

  it('shows a provisioning authorization failure without starting the operation', async () => {
    const api = getApi()
    const provision = vi.spyOn(api.provision, 'pybrainage')
    vi.spyOn(api.execution, 'authorize').mockRejectedValue(
      'provision authorization denied',
    )
    renderScreen(
      <DiagnosticsScreen report={PYBRAINAGE_REPORT} safeExecution={true} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set up PyBrainAge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize setup' }))

    expect(
      await screen.findByText('provision authorization denied'),
    ).toHaveAttribute('role', 'status')
    expect(provision).not.toHaveBeenCalled()
  })

  it('ignores foreign provisioning progress and accepts a matching error event', async () => {
    const api = getApi()
    let progress:
      | ((event: {
          phase: 'error'
          percent: number | null
          message: string
          projectId: string
          projectEpoch: number
          operationId: string
        }) => void)
      | null = null
    const off = vi.fn()
    vi.spyOn(api.provision, 'onProgress').mockImplementation((callback) => {
      progress = callback
      return off
    })
    const provision = vi
      .spyOn(api.provision, 'pybrainage')
      .mockResolvedValue({ operationId: 'provision-test' })
    renderScreen(
      <DiagnosticsScreen report={PYBRAINAGE_REPORT} safeExecution={true} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set up PyBrainAge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize setup' }))
    await waitFor(() => expect(provision).toHaveBeenCalledOnce())
    expect(progress).not.toBeNull()

    act(() => {
      progress?.({
        phase: 'error',
        percent: 20,
        message: 'foreign operation',
        projectId: 'another-project',
        projectEpoch: DIAGNOSTICS_PROJECT.epoch,
        operationId: 'foreign',
      })
    })
    expect(screen.queryByText(/foreign operation/)).toBeNull()

    act(() => {
      progress?.({
        phase: 'error',
        percent: null,
        message: 'Verify the model checksum again.',
        projectId: DIAGNOSTICS_PROJECT.projectId,
        projectEpoch: DIAGNOSTICS_PROJECT.epoch,
        operationId: 'provision-test',
      })
    })
    expect(
      await screen.findByText('Verify the model checksum again.'),
    ).toHaveAttribute('role', 'status')
    expect(off).toHaveBeenCalledOnce()
  })

  it('streams provisioning output lines beneath the setup status', async () => {
    const api = getApi()
    let progress: Parameters<typeof api.provision.onProgress>[0] | null = null
    let log: Parameters<typeof api.provision.onLog>[0] | null = null
    vi.spyOn(api.provision, 'onProgress').mockImplementation((callback) => {
      progress = callback
      return vi.fn()
    })
    const offLog = vi.fn()
    vi.spyOn(api.provision, 'onLog').mockImplementation((callback) => {
      log = callback
      return offLog
    })
    vi.spyOn(api.provision, 'pybrainage').mockResolvedValue({
      operationId: 'provision-log',
    })
    renderScreen(
      <DiagnosticsScreen report={PYBRAINAGE_REPORT} safeExecution={true} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set up PyBrainAge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize setup' }))
    await waitFor(() => expect(log).not.toBeNull())
    expect(screen.queryByRole('log')).toBeNull()
    const base = {
      projectId: DIAGNOSTICS_PROJECT.projectId,
      projectEpoch: DIAGNOSTICS_PROJECT.epoch,
      operationId: 'provision-log',
      at: 1_700_000_000_000,
    }
    // The adapter reports each step as "Run <step>." in the status and the
    // output alike; both read as the step's fact.
    await act(async () => {
      log?.({ ...base, line: 'Run create_env.' })
      progress?.({
        phase: 'env',
        percent: 10,
        message: 'Run create_env.',
        projectId: DIAGNOSTICS_PROJECT.projectId,
        projectEpoch: DIAGNOSTICS_PROJECT.epoch,
        operationId: 'provision-log',
      })
      log?.({ ...base, line: '$ micromamba create --yes' })
      log?.({ ...base, line: 'Transaction finished' })
      log?.({ ...base, projectEpoch: base.projectEpoch + 1, line: 'stale' })
      await Promise.resolve()
    })
    expect(
      screen.getByText('10% Creating the locked environment...'),
    ).toHaveAttribute('role', 'status')
    const panel = screen.getByRole('log', {
      name: 'PyBrainAge setup output',
    })
    expect(panel).toHaveTextContent('Creating the locked environment...')
    expect(panel).not.toHaveTextContent('Run create_env.')
    expect(panel).toHaveTextContent('$ micromamba create --yes')
    expect(panel).toHaveTextContent('Transaction finished')
    expect(panel).not.toHaveTextContent('stale')

    await act(async () => {
      progress?.({
        phase: 'error',
        percent: null,
        message: 'Fix create_env after this failure: micromamba exited 1.',
        projectId: DIAGNOSTICS_PROJECT.projectId,
        projectEpoch: DIAGNOSTICS_PROJECT.epoch,
        operationId: 'provision-log',
      })
      await Promise.resolve()
    })
    expect(
      await screen.findByText(
        'Creating the locked environment failed: micromamba exited 1.',
      ),
    ).toHaveAttribute('role', 'status')
    expect(screen.getByRole('log')).toHaveTextContent('Transaction finished')
    expect(offLog).toHaveBeenCalledOnce()
  })

  it('rejects an incomplete final provisioning status', async () => {
    const api = getApi()
    let progress: Parameters<typeof api.provision.onProgress>[0] | null = null
    vi.spyOn(api.provision, 'onProgress').mockImplementation((callback) => {
      progress = callback
      return vi.fn()
    })
    vi.spyOn(api.provision, 'pybrainage').mockResolvedValue({
      operationId: 'provision-incomplete',
    })
    vi.spyOn(api.provision, 'status').mockResolvedValue({
      envReady: false,
      modelReady: true,
      pythonExecutable: '/env/bin/python',
      modelPath: '/model',
      scalerPath: '/scaler',
      projectId: DIAGNOSTICS_PROJECT.projectId,
      projectEpoch: DIAGNOSTICS_PROJECT.epoch,
      configRevision: 0,
      operationId: 'provision-incomplete',
      phase: 'done',
      cancellable: false,
      error: null,
    })
    renderScreen(
      <DiagnosticsScreen report={PYBRAINAGE_REPORT} safeExecution={true} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Set up PyBrainAge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Authorize setup' }))
    await waitFor(() => expect(progress).not.toBeNull())
    await act(async () => {
      progress?.({
        phase: 'done',
        percent: 100,
        message: 'operation reported done',
        projectId: DIAGNOSTICS_PROJECT.projectId,
        projectEpoch: DIAGNOSTICS_PROJECT.epoch,
        operationId: 'provision-incomplete',
      })
      await Promise.resolve()
    })

    expect(
      await screen.findByText(/Retry provisioning until it returns a complete/),
    ).toHaveAttribute('role', 'status')
  })

  it('surfaces install authorization errors as a real failed outcome', async () => {
    const api = getApi()
    const install = vi.spyOn(api.env, 'optInInstall')
    vi.spyOn(api.execution, 'authorize').mockRejectedValue(
      'installer authorization unavailable',
    )
    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={true}
      />,
    )
    await findCallout()
    const row = envRow('rscript')
    fireEvent.click(
      within(row).getByRole('button', { name: 'Install Rscript' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Authorize install' }))

    expect(
      await within(row).findByText('The installation of Rscript failed.'),
    ).toBeInTheDocument()
    expect(row).toHaveTextContent('installer authorization unavailable')
    expect(install).not.toHaveBeenCalled()
  })

  it('reports clipboard denial and exposes the Allow live runs opt-in callback', async () => {
    const onSafeExecutionChange = vi.fn()
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(
      new Error('clipboard denied'),
    )
    renderScreen(
      <DiagnosticsScreen
        report={INSTALLABLE_REQUIRED_REPORT}
        safeExecution={false}
        onSafeExecutionChange={onSafeExecutionChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy install plan' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Grant clipboard permission, then copy the command again.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Allow live runs' }))
    expect(onSafeExecutionChange).toHaveBeenCalledWith(true)
  })

  it('resyncs the top-bar tool chips with every completed environment check', async () => {
    const toolStatus = vi.spyOn(getApi().env, 'toolStatus')
    renderScreen(<DiagnosticsScreen safeExecution={false} />)

    await findLoaded()
    await waitFor(() => expect(toolStatus).toHaveBeenCalled())
    const afterFirstCheck = toolStatus.mock.calls.length

    fireEvent.click(
      screen.getByRole('button', { name: 'Re-check environment' }),
    )
    await waitFor(() =>
      expect(toolStatus.mock.calls.length).toBeGreaterThan(afterFirstCheck),
    )
  })

  it('hands every completed project-scoped report to the shell', async () => {
    // The run gate reads the shell's report; a re-check after the operator
    // repaired the environment must reach it, or the stage stays blocked
    // until the project is reopened.
    const onReport = vi.fn()
    renderScreen(
      <DiagnosticsScreen safeExecution={false} onReport={onReport} />,
    )

    await findLoaded()
    await waitFor(() => expect(onReport).toHaveBeenCalled())
    const afterFirstCheck = onReport.mock.calls.length

    fireEvent.click(
      screen.getByRole('button', { name: 'Re-check environment' }),
    )
    await waitFor(() =>
      expect(onReport.mock.calls.length).toBeGreaterThan(afterFirstCheck),
    )
    const [report] = onReport.mock.calls.at(-1) ?? []
    expect(report).toEqual(
      expect.objectContaining({ groups: expect.any(Array) }),
    )
  })

  it('renders the host-scoped report before a project opens', async () => {
    const check = vi.spyOn(getApi().env, 'check')
    render(
      <AppProvider>
        <RoutePeek />
        <DiagnosticsScreen />
      </AppProvider>,
    )

    expect(await screen.findByText(/No project is open/)).toBeInTheDocument()
    await waitFor(() => expect(check).toHaveBeenCalledWith({}))
    await screen.findByRole('group', { name: 'Environment check groups' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Project configuration panels wait for a project.
    expect(
      screen.queryByText('FreeSurfer configuration'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('ENIGMA QC configuration'),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to Setup' }))
    expect(screen.getByText('route:wizard')).toBeInTheDocument()
  })

  it.each([
    ['queued', 'missing', 'Queued'],
    ['pulling', 'missing', 'Downloading'],
    ['importing', 'missing', 'Importing'],
    ['verifying', 'missing', 'Verifying'],
    ['done', 'missing', 'Finished'],
    ['idle', 'unavailable', 'Unavailable'],
    ['idle', 'invalid', 'Verification failed'],
    ['error', 'missing', 'Failed'],
  ] as const)(
    'labels a %s managed resource in the %s state as "%s"',
    async (phase, state, label) => {
      vi.spyOn(getApi().managedResource, 'status').mockImplementation(
        async ({ resource, variant }) =>
          resourceStatus(resource, variant, { phase, state }),
      )
      renderScreen(<ScientificResourcesPanel safeExecution={false} />)

      await screen.findByRole('group', { name: 'Scientific resources' })
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0)
    },
  )

  it('offers runtime recovery once an unanswered environment check stalls', async () => {
    vi.useFakeTimers()
    try {
      const api = getApi()
      const pending = deferred<EnvReport>()
      const check = vi.spyOn(api.env, 'check').mockReturnValue(pending.promise)
      let finishRecovery: () => void = () => undefined
      const retrySidecar = vi.spyOn(api.host, 'retrySidecar').mockReturnValue(
        new Promise<void>((resolve) => {
          finishRecovery = resolve
        }),
      )
      renderScreen(<DiagnosticsScreen />)

      await act(async () => {
        await Promise.resolve()
      })
      expect(
        screen.queryByText('The environment check is not responding.'),
      ).not.toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(45_000)
      })
      expect(
        screen.getByText('The environment check is not responding.'),
      ).toBeInTheDocument()
      const before = check.mock.calls.length

      fireEvent.click(screen.getByRole('button', { name: 'Recover runtime' }))
      expect(
        screen.getByRole('button', { name: 'Recovering the runtime...' }),
      ).toBeInTheDocument()

      await act(async () => {
        finishRecovery()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(retrySidecar).toHaveBeenCalledOnce()
      // Recovery re-runs the check and returns the control to the operator.
      expect(check.mock.calls.length).toBe(before + 1)
      expect(
        screen.getByRole('button', { name: 'Recover runtime' }),
      ).toBeInTheDocument()
      pending.resolve(EMPTY_REPORT)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the recovery control usable after the runtime refuses to restart', async () => {
    vi.useFakeTimers()
    try {
      const api = getApi()
      const pending = deferred<EnvReport>()
      const check = vi.spyOn(api.env, 'check').mockReturnValue(pending.promise)
      const retrySidecar = vi
        .spyOn(api.host, 'retrySidecar')
        .mockRejectedValue(
          new Error(
            'Restart Supraspina because the scientific runtime is locked.',
          ),
        )
      renderScreen(<DiagnosticsScreen />)

      await act(async () => {
        await Promise.resolve()
      })
      act(() => {
        vi.advanceTimersByTime(45_000)
      })
      const before = check.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: 'Recover runtime' }))
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(retrySidecar).toHaveBeenCalledOnce()
      expect(check.mock.calls.length).toBe(before + 1)
      expect(
        screen.getByRole('button', { name: 'Recover runtime' }),
      ).toBeInTheDocument()
      pending.resolve(EMPTY_REPORT)
    } finally {
      vi.useRealTimers()
    }
  })
})
