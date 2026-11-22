/**
 * A {@link SupraspinaApi} mock for browser previews and renderer tests. It starts
 * with an empty project to model a fresh install. Call {@link makeMockCohort}
 * when a test needs sample rows. Prefer the Electron preload bridge whenever it
 * exists, and install this mock only when the bridge is absent.
 *
 * Mock values stay aligned with a plausible live host: FreeSurfer 8.2.0 and
 * MATLAB R2026a, with unavailable optional packages and models omitted.
 */

import { version as APP_VERSION } from '../../../package.json'
import type {
  BoundaryRequest,
  EnvInstallState,
  HostState,
  ManagedResourceProgress,
  ManagedResourceStatusResult,
  ManifestPage,
  PlatformMode,
  ProvisionLogLine,
  ProvisionProgress,
  ProvisionStatus,
  QcGalleryImage,
  QcGalleryPanel,
  QcGalleryView,
  RegistrationOperation,
  RegistrationSubjectResult,
  RegistryImportIssue,
  RegistryImportResult,
  RegistryInput,
  RegistryRecord,
  ResultArtifact,
  ResultPage,
  RuntimeEvent,
  RuntimeSnapshot,
  SupraspinaApi,
  StepDescriptor,
  SurfaceRegistrationStatus,
  Unsubscribe,
  UpdateState,
  WorkflowNode,
  WorkflowRequest,
  WorkflowResult,
  WindowPlacementPreference,
  WindowPlacementState,
} from '../../shared/contract'
import { REQUIRED_SIDECAR_CAPABILITIES } from '../../shared/contract'
import {
  REGISTRY_IMPORT_COLUMNS,
  REGISTRY_IMPORT_EXAMPLE_CSV,
} from '../../shared/registry-import'
import {
  normalizeSiteLabel,
  parseRegistrySetSiteFields,
  siteLabelConflict,
} from '../../shared/sites'
import {
  DEFAULT_PROJECT_CONFIG,
  validateProjectConfig,
} from '../../shared/project-schema'
import type { ProjectConfig } from '../../shared/project-schema'
import {
  MATRIX_STEPS,
  PIPELINE_STEPS,
  STEP_SCOPES,
  advancedColumns,
  dependenciesForStep,
} from '../../shared/steps'
import type { StepKey } from '../../shared/steps'
import type {
  Cell,
  CellState,
  EnvCreateDirResult,
  EnvReport,
  Job,
  LogLevel,
  ProjectRef,
  RunManifest,
  Subject,
  ToolStatus,
} from '../../shared/types'
import { emptyCell } from '../../shared/types'
import {
  QC_FAIL_EXCLUSION_REASON,
  isAnalysisEligible,
  normalizeAnalysisSubjects,
} from '../../shared/analysis-cohort'
import {
  DEFAULT_MACHINE_PREFERENCES,
  sanitizeMachinePreferences,
  validateMachinePreferencesPatch,
  type MachinePreferencesState,
} from '../../shared/preferences'
import { createMockGroupAnalysis } from './mock-group-analysis'
import { createMockAtlasSources } from './mock-analysis-v2'
import { brainchartsSiteFact, siteLabels } from '../state/site-facts'

/** Generate deterministic values with mulberry32. */
function makeRng(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const COHORTS = ['CTRL', 'SCI_nNP', 'SCI_P'] as const
const AIS = ['A', 'B', 'C', 'D'] as const
const FAIL_CODES = [137, 1, 2, 139]
const FAIL_TAGS = [
  'oom_killed',
  'License check failed',
  'segfault in mris_inflate',
  'no such file or directory',
]

/** Map each matrix column key to its subject-cell index. */
const MOCK_COLUMN_INDEX: Record<string, number> = (() => {
  const out: Record<string, number> = {}
  MATRIX_STEPS.forEach((m, i) => {
    out[m.key] = i
  })
  return out
})()

/**
 * Derive demo step states from matrix cells. Mark a step done only when every
 * advanced column is done. Leave steps without columns pending. Let the real
 * sidecar derive precise state through each step detector.
 */
function mockStepStates(cells: Cell[]): Partial<Record<StepKey, CellState>> {
  const out: Partial<Record<StepKey, CellState>> = {}
  for (const step of PIPELINE_STEPS) {
    const cols = advancedColumns(step.key)
    out[step.key] =
      cols.length > 0 &&
      cols.every((c) => {
        const idx = MOCK_COLUMN_INDEX[c]
        return idx !== undefined && cells[idx]?.st === 'done'
      })
        ? 'done'
        : 'pending'
  }
  return out
}

const MOCK_REGISTRATION_REFERENCE = {
  cortex: { median: 0.8342, scale: 0.0198 },
  dfp: { median: 0.8556, scale: 0.0235 },
} as const

/**
 * Build a surface-registration status for the mock cohort: every subject with
 * a finished reconstruction is checked, and the third one's right hemisphere
 * fits the atlas poorly, as a misregistered hemisphere does.
 *
 * @param operation - The last mock check, if any.
 */
export function mockSurfaceRegistrationStatus(
  subjects: readonly Subject[],
  operation: RegistrationOperation | null,
  configRevision = 0,
): SurfaceRegistrationStatus {
  const reconstructed = subjects.filter((subject) =>
    MATRIX_STEPS.some(
      (step, index) =>
        step.key === 'recon' && subject.cells[index]?.st === 'done',
    ),
  )
  const rows: RegistrationSubjectResult[] = reconstructed.map(
    (subject, index) => {
      const hemispheres = (['lh', 'rh'] as const).map((hemisphere, side) => {
        const shifted = index === 2 && hemisphere === 'rh'
        const rCortex = shifted
          ? 0.7512
          : Number((0.834 + (((index * 7 + side) % 10) - 5) * 0.004).toFixed(4))
        const rDfp = shifted
          ? 0.7018
          : Number((0.855 + (((index * 3 + side) % 10) - 5) * 0.005).toFixed(4))
        const zCortex =
          (rCortex - MOCK_REGISTRATION_REFERENCE.cortex.median) /
          MOCK_REGISTRATION_REFERENCE.cortex.scale
        const zDfp =
          (rDfp - MOCK_REGISTRATION_REFERENCE.dfp.median) /
          MOCK_REGISTRATION_REFERENCE.dfp.scale
        const measure = zDfp <= zCortex ? ('dfp' as const) : ('cortex' as const)
        const z = Math.min(zCortex, zDfp)
        return {
          hemisphere,
          state: 'checked' as const,
          rCortex,
          rDfp,
          flagged: z < -3 || Math.min(rCortex, rDfp) < 0.7,
          measure,
          z: Number(z.toFixed(3)),
          message: null,
        }
      })
      return {
        subjectId: subject.id,
        flagged: hemispheres.some((item) => item.flagged),
        hemispheres,
      }
    },
  )
  const checked = rows.length * 2
  const flaggedHemispheres = rows.reduce(
    (total, row) =>
      total + row.hemispheres.filter((item) => item.flagged).length,
    0,
  )
  return {
    configRevision,
    method: 'sulc-fsaverage-pearson-v1',
    available: true,
    unavailableReason: null,
    rule: { zLimit: -3, floor: 0.7, minCohortHemispheres: 20 },
    reference: {
      source: checked >= 20 ? 'cohort' : 'builtin',
      hemispheres: checked,
      ...MOCK_REGISTRATION_REFERENCE,
    },
    operation,
    subjects: rows,
    counts: {
      subjects: rows.length,
      checked,
      pending: 0,
      failed: 0,
      missing: 0,
      flaggedSubjects: rows.filter((row) => row.flagged).length,
      flaggedHemispheres,
    },
  }
}

/** Matrix columns that subject-scope stages advance, such as recon-all. */
const MOCK_SUBJECT_SCOPE_COLUMNS: ReadonlySet<string> = new Set(
  (Object.keys(STEP_SCOPES) as StepKey[])
    .filter((key) => STEP_SCOPES[key] === 'subject')
    .flatMap((key) => advancedColumns(key)),
)

/** Build a deterministic mock cohort of `n` subjects. */
export function makeMockCohort(n: number, seed = 17): Subject[] {
  const rng = makeRng(seed)
  const subjects: Subject[] = []
  for (let i = 0; i < n; i++) {
    const cohort = COHORTS[Math.floor(rng() * COHORTS.length)] ?? 'CTRL'
    const isSci = cohort.startsWith('SCI')
    const cells: Cell[] = []
    let stop = false
    let cursor = Date.now() - Math.floor(rng() * 7_200_000)
    for (const step of MATRIX_STEPS) {
      // The BrainCharts stage is off by default, so its column draws no
      // random state and the rest of the seeded cohort stays as it was.
      if (step.key === 'norm') {
        cells.push(emptyCell())
        continue
      }
      let st: CellState
      if (stop) {
        st = 'pending'
      } else {
        const r = rng()
        if (r < 0.62) st = 'done'
        else if (r < 0.74) st = 'failed'
        else if (r < 0.82) st = 'running'
        else if (r < 0.86) st = 'skipped'
        else st = 'pending'
        if (st === 'failed' || st === 'running' || st === 'pending') stop = true
        // A cohort stage's job fails for every subject at once, so one
        // subject's cohort column never fails alone; the draw stands for a
        // blocked cell instead. Same draws, same cohort.
        if (st === 'failed' && !MOCK_SUBJECT_SCOPE_COLUMNS.has(step.key)) {
          st = 'blocked'
        }
      }
      const finished = st === 'done' || st === 'failed' || st === 'skipped'
      cells.push({
        st,
        startedAt: st !== 'pending' ? cursor : null,
        finishedAt: finished ? cursor + step.dur : null,
        progress: st === 'running' ? Math.floor(rng() * 80) + 10 : null,
        rc:
          st === 'failed'
            ? (FAIL_CODES[Math.floor(rng() * 4)] ?? 1)
            : st === 'done'
              ? 0
              : null,
        err:
          st === 'failed' ? (FAIL_TAGS[Math.floor(rng() * 4)] ?? null) : null,
      })
      cursor += step.dur
    }
    const qc = rng() < 0.4 ? (rng() < 0.7 ? 'pass' : 'fail') : null
    subjects.push({
      id: `sub-${String(i + 1).padStart(3, '0')}`,
      age: 22 + Math.floor(rng() * 50),
      sex: rng() < 0.5 ? 'M' : 'F',
      cohort,
      ais: isSci ? (AIS[Math.floor(rng() * AIS.length)] ?? 'A') : null,
      tSinceSci: isSci ? Number((rng() * 8).toFixed(1)) : null,
      cells,
      stepStates: mockStepStates(cells),
      qc,
      notes: '',
      registered: true,
      // Every synthetic subject has one T1 input, which its runs read.
      t1Availability: 'available',
      analysisEligible: qc !== 'fail',
      unavailableReason: qc === 'fail' ? QC_FAIL_EXCLUSION_REASON : null,
    })
  }
  return subjects
}

/**
 * The tools the mock host has set up. A host that finished a stage has that
 * stage's tools, so the demo never lists a finished stage's tool as missing.
 */
interface MockHostReadiness {
  readonly pyBrainAge: boolean
  readonly rAnalysis: boolean
  readonly brainCharts: boolean
}

const MOCK_HOST_UNPROVISIONED: MockHostReadiness = {
  pyBrainAge: false,
  rAnalysis: false,
  brainCharts: false,
}

/** Return the R analysis checks, with the report packages installed or not. */
function mockRAnalysisChecks(
  ready: boolean,
): EnvReport['groups'][number]['checks'] {
  if (ready) {
    return [
      {
        id: 'rpkgs',
        label: 'Optional R packages',
        status: 'found',
        detail: 'showtext, sysfonts, and writexl are installed.',
      },
      {
        id: 'rmarkdown',
        label: 'R Markdown package',
        status: 'found',
        detail: 'rmarkdown is installed for /usr/bin/Rscript.',
      },
      {
        id: 'knitr',
        label: 'knitr package',
        status: 'found',
        detail: 'knitr is installed for /usr/bin/Rscript.',
      },
      {
        id: 'pandoc',
        label: 'Pandoc',
        status: 'found',
        detail: '/usr/bin/pandoc',
      },
    ]
  }
  return [
    {
      id: 'rpkgs',
      label: 'Optional R packages',
      status: 'missing',
      detail: 'missing: showtext, sysfonts, writexl',
      recommendedCmd:
        "Rscript -e \"install.packages(c('showtext','sysfonts','writexl'))\"",
    },
    {
      id: 'rmarkdown',
      label: 'R Markdown package',
      status: 'missing',
      detail: 'Install rmarkdown for /usr/bin/Rscript.',
      recommendedCmd: 'Rscript -e "install.packages(\'rmarkdown\')"',
      installable: true,
    },
    {
      id: 'knitr',
      label: 'knitr package',
      status: 'missing',
      detail: 'Install knitr for /usr/bin/Rscript.',
      recommendedCmd: 'Rscript -e "install.packages(\'knitr\')"',
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
  ]
}

/** Return the PyBrainAge runtime and model checks, set up or not. */
function mockPyBrainAgeChecks(
  ready: boolean,
): EnvReport['groups'][number]['checks'] {
  const root = '/data/outputs/.pybrainage/current'
  return [
    ready
      ? {
          id: 'pybrainpython',
          label: 'Pinned PyBrainAge runtime',
          status: 'found',
          detail: `${root}/envs/pybrainage/bin/python`,
        }
      : {
          id: 'pybrainpython',
          label: 'Pinned PyBrainAge runtime',
          status: 'missing',
          detail: 'Provision the PyBrainAge environment.',
        },
    {
      id: 'agepython',
      label: 'Age metadata runtime',
      status: 'found',
    },
    {
      id: 'clinicalpython',
      label: 'Clinical metadata runtime',
      status: 'found',
    },
    {
      id: 'brainpadpython',
      label: 'BrainPAD runtime',
      status: 'found',
    },
    {
      id: 'aggregatepython',
      label: 'Aggregation runtime',
      status: 'found',
    },
    ready
      ? {
          id: 'modelfile',
          label: 'PyBrainAge model',
          status: 'found',
          detail: `${root}/pybrainage/v3/software/ExtraTreesModel`,
        }
      : {
          id: 'modelfile',
          label: 'PyBrainAge model',
          status: 'missing',
          detail: 'Download the model files.',
          downloadUrl: 'https://doi.org/10.5281/zenodo.10406573',
          action: { kind: 'setup-pybrainage', label: 'Set up PyBrainAge' },
        },
    ready
      ? {
          id: 'scalerfile',
          label: 'PyBrainAge scaler',
          status: 'found',
          detail: `${root}/pybrainage/v3/software/scaler.pkl`,
        }
      : {
          id: 'scalerfile',
          label: 'PyBrainAge scaler',
          status: 'missing',
          detail: 'Download the scaler file.',
          downloadUrl: 'https://doi.org/10.5281/zenodo.10406573',
          action: { kind: 'setup-pybrainage', label: 'Set up PyBrainAge' },
        },
  ]
}

/** Return a host-realistic mock environment report. */
function mockEnvReport(
  ready: MockHostReadiness = MOCK_HOST_UNPROVISIONED,
): EnvReport {
  const brainChartsReady = ready.brainCharts
  return {
    capturedAt: new Date().toISOString(),
    availableMemoryGB: 24,
    groups: [
      {
        name: 'Platform',
        checks: [
          {
            id: 'os',
            label: 'Operating system',
            status: 'found',
            detail: 'Linux (native)',
          },
          {
            id: 'mode',
            label: 'Platform mode',
            status: 'found',
            detail: 'linux',
          },
          {
            id: 'wsl',
            label: 'WSL detected',
            status: 'skipped',
            detail:
              'Supraspina uses paths as they are, without translation, on this non-WSL host.',
          },
          {
            id: 'display',
            label: 'X display',
            status: 'found',
            detail: 'DISPLAY=:0',
          },
        ],
      },
      {
        name: 'Shell utilities',
        checks: [
          { id: 'bash', label: 'bash', status: 'found' },
          { id: 'awk', label: 'awk', status: 'found' },
          { id: 'grep', label: 'grep', status: 'found' },
          { id: 'cat', label: 'cat', status: 'found' },
          { id: 'mkdir', label: 'mkdir', status: 'found' },
          {
            id: 'wslpath',
            label: 'wslpath',
            status: 'skipped',
            detail: 'wslpath is not needed outside WSL mode.',
          },
          { id: 'xvfb-run', label: 'xvfb-run', status: 'skipped' },
        ],
      },
      {
        name: 'FreeSurfer',
        checks: [
          {
            id: 'fshome',
            label: 'FREESURFER_HOME',
            status: 'found',
            detail: '/usr/local/freesurfer/8.2.0',
          },
          {
            id: 'reconall',
            label: 'recon-all',
            status: 'found',
            detail: 'v8.2.0',
          },
          { id: 'aparcstats', label: 'aparcstats2table', status: 'found' },
          { id: 'asegstats', label: 'asegstats2table', status: 'found' },
          {
            id: 'featurepython',
            label: 'Feature extraction Python',
            status: 'found',
            detail: '/usr/local/freesurfer/8.2.0/bin/fspython',
          },
          {
            id: 'license',
            label: 'License file',
            status: 'found',
            detail: 'present (mode 600)',
          },
        ],
      },
      {
        name: 'MATLAB / MATLAB Runtime',
        checks: [
          {
            id: 'enigma_assets',
            label: 'ENIGMA QC assets',
            status: 'found',
          },
          {
            id: 'matlab',
            label: 'MATLAB',
            status: 'found',
            detail:
              'R2026a at /opt/MATLAB/R2026a with Image Processing Toolbox (preferred source ENIGMA QC backend)',
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
            status: 'skipped',
            detail:
              'Select the installed R2019b (9.7) MATLAB Runtime root for the compiled ENIGMA QC backend. This backend is optional because source MATLAB is the selected ENIGMA QC backend. Use it as the license-free alternative by selecting the mcr backend in the ENIGMA QC step options; the compiled route requires the R2019b (9.7) MATLAB Runtime and the verified compiled ENIGMA assets.',
          },
        ],
      },
      {
        name: 'Defacing',
        checks: [
          {
            id: 'mri_deface',
            label: 'mri_deface',
            status: 'found',
          },
          {
            id: 'mri_deface_templates',
            label: 'mri_deface GCA templates',
            status: 'found',
          },
          {
            id: 'fsl_deface',
            label: 'fsl_deface',
            status: 'missing',
            detail: 'The default pipeline does not use this optional defacer.',
          },
          {
            id: 'pydeface',
            label: 'pydeface',
            status: 'missing',
            detail: 'The default pipeline does not use this optional defacer.',
          },
        ],
      },
      {
        name: 'R',
        checks: [
          {
            id: 'rscript',
            label: 'Rscript',
            status: 'found',
            detail: 'R 4.3.3',
          },
          {
            id: 'finalrscript',
            label: 'R analysis Rscript',
            status: 'found',
            detail: 'R 4.3.3',
          },
          ...mockRAnalysisChecks(ready.rAnalysis),
        ],
      },
      {
        name: 'Python / PyBrainAge',
        checks: mockPyBrainAgeChecks(ready.pyBrainAge),
      },
      {
        name: 'Pipeline assets',
        checks: [
          {
            id: 'features_assets',
            label: 'Feature extraction assets',
            status: 'found',
          },
          {
            id: 'outliers_assets',
            label: 'Outlier review assets',
            status: 'found',
          },
          {
            id: 'pybrainage_assets',
            label: 'PyBrainAge integration assets',
            status: 'found',
          },
          { id: 'brainpad_assets', label: 'BrainPAD assets', status: 'found' },
          {
            id: 'aggregate_assets',
            label: 'Aggregation assets',
            status: 'found',
          },
          {
            id: 'final_assets',
            label: 'R analysis assets',
            status: 'found',
          },
          {
            id: 'final_report_assets',
            label: 'R report assets',
            status: 'found',
          },
        ],
      },
      {
        name: 'BrainCharts',
        checks: brainChartsReady
          ? [
              {
                id: 'bcenv',
                label: 'BrainCharts runtime',
                status: 'found',
                detail:
                  '/data/outputs/.braincharts/current/envs/braincharts/bin/python (provenance 4716f522).',
              },
              {
                id: 'bcmodel',
                label: 'BrainCharts lifespan model',
                status: 'found',
                detail:
                  '/data/outputs/.braincharts/current/models/lifespan_57K_82sites (provenance 4716f522).',
              },
            ]
          : (['bcenv', 'bcmodel'] as const).map((id) => ({
              id,
              label:
                id === 'bcenv'
                  ? 'BrainCharts runtime'
                  : 'BrainCharts lifespan model',
              status: 'missing' as const,
              detail:
                'BrainCharts is not set up. Scientific resources downloads the model and builds its runtime after the license notice is accepted.',
            })),
      },
    ],
  }
}

/**
 * State the site advisories the sidecar's planner adds (workflow.py): the
 * sites without controls that Brain-PAD statistics pool, and the sites
 * BrainCharts refuses, each only while its stage is planned.
 */
function mockPlanAdvisories(
  analysis: readonly Subject[],
  nodes: readonly WorkflowNode[],
): string[] {
  const planned = (key: StepKey): boolean =>
    nodes.some((node) => node.stepKey === key && node.status === 'planned')
  const advisories: string[] = []
  const lacking = siteLabels(analysis.map((subject) => subject.site)).filter(
    (site) =>
      !analysis.some(
        (subject) => subject.site === site && subject.cohortRole === 'healthy',
      ),
  )
  if (planned('brainpad') && lacking.length > 0) {
    const named =
      lacking.length === 1
        ? `site ${lacking[0]} has`
        : `sites ${lacking.slice(0, -1).join(', ')}${lacking.length > 2 ? ',' : ''} and ${lacking.at(-1)} have`
    advisories.push(
      `Brain-PAD statistics pool all sites; ${named} no controls.`,
    )
  }
  const fact = brainchartsSiteFact(
    analysis.map((subject) => ({
      site: subject.site,
      role: subject.cohortRole,
      age: subject.age,
      sex: subject.sex,
    })),
  )
  if (planned('braincharts') && fact?.text.startsWith('Adapts')) {
    if (fact.tone === 'warn') {
      advisories.push(fact.text.replace(/^Adapts/, 'BrainCharts adapts'))
    }
  }
  return advisories
}

/**
 * Return a host-realistic mock top-bar tool summary. Mirror the sidecar rules:
 * report the selected ENIGMA QC backend rather than the best one, name the
 * selected reconstruction backend, and report a disabled stage's tool as not
 * applicable.
 */
function mockToolStatus(
  cfg?: ProjectConfig,
  ready: MockHostReadiness = MOCK_HOST_UNPROVISIONED,
): ToolStatus {
  const configured = String(cfg?.steps.enigma?.params['backend'] ?? 'auto')
  const available: Record<string, boolean> = { matlab: true, mcr: false }
  // Resolve auto like the sidecar: the first available backend, MATLAB first.
  const backend =
    configured === 'auto'
      ? (['matlab', 'mcr'].find((id) => available[id]) ?? 'matlab')
      : configured
  const enabled = (key: StepKey): boolean => cfg?.steps[key]?.enabled !== false
  // Mirror the sidecar's asset item: it applies while any stage that reads a
  // reviewed asset is enabled, and the mock host has every asset verified.
  const assetStages: StepKey[] = [
    'enigma',
    'outliers',
    'features',
    'pybrainage',
    'brainpad',
    'aggregate',
    'final',
  ]
  const fastsurfer =
    String(cfg?.steps.recon?.params['backend'] ?? 'freesurfer') === 'fastsurfer'
  const qc = available[backend] === true ? 'ok' : 'missing'
  const items: ToolStatus['items'] = [
    {
      id: 'fs',
      label: fastsurfer ? 'FastSurfer' : 'FreeSurfer',
      status: enabled('recon') ? 'ok' : 'na',
    },
    { id: 'qc', label: 'QC backend', status: enabled('enigma') ? qc : 'na' },
    { id: 'analysis', label: 'Analysis Python', status: 'ok' },
    {
      id: 'py',
      label: 'PyBrainAge',
      status: enabled('pybrainage')
        ? ready.pyBrainAge
          ? 'ok'
          : 'missing'
        : 'na',
    },
    {
      id: 'r',
      label: 'R packages',
      status: enabled('final') ? (ready.rAnalysis ? 'ok' : 'missing') : 'na',
    },
    {
      id: 'assets',
      label: 'Scientific assets',
      status: assetStages.some(enabled) ? 'ok' : 'na',
    },
    // Listed only while the project turns BrainCharts on, as the sidecar
    // does.
    ...(cfg?.steps.braincharts?.enabled === true
      ? [
          {
            id: 'braincharts',
            label: 'BrainCharts',
            status: ready.brainCharts ? ('ok' as const) : ('missing' as const),
          },
        ]
      : []),
  ]
  const summary = items.some((item) => item.status === 'missing')
    ? 'missing'
    : items.some((item) => item.status === 'warn')
      ? 'warn'
      : 'ok'
  return {
    capturedAt: new Date().toISOString(),
    items,
    summary,
  }
}

function mockManifest(runId: string): RunManifest {
  return {
    runId,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    endedAt: null,
    user: 'mock',
    host: 'mock-host',
    product: { name: 'Supraspina', version: APP_VERSION },
    git: { repo: '', sha: '8a8c2d3', dirty: false },
    configSha256:
      '0000000000000000000000000000000000000000000000000000000000000000',
    steps: PIPELINE_STEPS.map((s) => ({
      id: s.id,
      key: s.key,
      status: 'queued' as const,
      subjects: 0,
      failed: 0,
      durationSec: 0,
    })),
    tools: {
      freesurfer: '8.2.0',
      matlab: 'R2026a',
      python: '3.12',
      R: '4.3.3',
    },
  }
}

/** Create a small multi-subscriber event emitter. */
function emitter<Args extends unknown[]>(): {
  on: (cb: (...args: Args) => void) => Unsubscribe
  emit: (...args: Args) => void
  size: () => number
} {
  const subs = new Set<(...args: Args) => void>()
  return {
    on: (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    emit: (...args) => subs.forEach((cb) => cb(...args)),
    size: () => subs.size,
  }
}

/** Construct a fully typed mock implementation of the IPC contract. */
export function createMockApi(
  initialSubjects: readonly Subject[] = [],
): SupraspinaApi {
  let cohort: Subject[] = normalizeAnalysisSubjects(initialSubjects)
  let registryRows: RegistryRecord[] = []
  // Like the sidecar's pending-sites.json: sites set before registration.
  const heldSites = new Map<string, string>()
  let registrationOperation: RegistrationOperation | null = null

  /** Build one registry row like the sidecar store and commit it in place. */
  const applyRegistryRecord = (record: RegistryInput): RegistryRecord => {
    const previous = registryRows.find(
      (row) => row.subjectId === record.subjectId,
    )
    const { site: requestedSite, ...fields } = record
    // Like the sidecar, a subject that discovery found keeps its T1 input.
    const t1Availability =
      cohort.find((subject) => subject.id === record.subjectId)
        ?.t1Availability ?? 'missing'
    const runnable = t1Availability === 'available'
    const row: RegistryRecord = {
      ...fields,
      cohortRole:
        record.sourceCohortLabel === 'CTRL' ||
        record.sourceCohortLabel === 'control'
          ? 'healthy'
          : record.sourceCohortLabel === 'SCI_nNP'
            ? 'sci-no-neuropathic-pain'
            : record.sourceCohortLabel === 'SCI_P'
              ? 'sci-neuropathic-pain'
              : 'ambiguous',
      t1Availability,
      runnable,
      unavailableReason: runnable
        ? null
        : 'Add a configured T1 input before discovery.',
      qc: previous?.qc ?? null,
      qcNote: previous?.qcNote ?? '',
      qcTags: previous?.qcTags ?? [],
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      // Like the sidecar: an input without the key keeps the stored site, and
      // a new record takes the site held for its registration.
      site:
        requestedSite === undefined
          ? previous
            ? previous.site
            : (heldSites.get(record.subjectId) ?? null)
          : normalizeSiteLabel(requestedSite),
    }
    heldSites.delete(record.subjectId)
    registryRows = [
      row,
      ...registryRows.filter((item) => item.subjectId !== row.subjectId),
    ]
    return row
  }
  let jobCounter = 1000
  let runCounter = 0
  let runtimeSequence = 0
  let currentCfg = DEFAULT_PROJECT_CONFIG
  let mockProvisionStatus: ProvisionStatus | null = null
  let mockBrainChartsReady = false
  const finishedStage = (key: StepKey): boolean =>
    cohort.some((subject) => subject.stepStates?.[key] === 'done')
  const hostReadiness = (): MockHostReadiness => ({
    pyBrainAge:
      mockProvisionStatus?.modelReady === true || finishedStage('pybrainage'),
    rAnalysis: finishedStage('final'),
    brainCharts: mockBrainChartsReady || finishedStage('braincharts'),
  })
  let currentProject: ProjectRef = {
    projectId: 'mock-project',
    root: '',
    configPath: '',
    epoch: 0,
  }
  let projectAttached = false
  let runtimeRuns: RuntimeSnapshot['runs'] = []
  let runtimeJobs: Job[] = []
  const runtimeLogs: RuntimeSnapshot['logTail'] = []
  const jobUpdate = emitter<[Job]>()
  const stdout = emitter<[string, string, LogLevel]>()
  const progress = emitter<[ProvisionProgress]>()
  const provisionLog = emitter<[ProvisionLogLine]>()
  const managedResourceProgress = emitter<[ManagedResourceProgress]>()
  const envInstallProgress = emitter<[EnvInstallState]>()
  let envInstalls: EnvInstallState[] = []

  /** Record and publish one step of a simulated installation. */
  const publishEnvInstall = (state: EnvInstallState): void => {
    envInstalls = [
      ...envInstalls.filter((item) => item.operationId !== state.operationId),
      state,
    ]
    envInstallProgress.emit(state)
  }
  const runtimeEvent = emitter<[RuntimeEvent]>()
  const hostState = emitter<[HostState]>()
  const lifecycleBoundary = emitter<[BoundaryRequest]>()
  const windowMaximize = emitter<[boolean]>()
  const preferencesChanged = emitter<[MachinePreferencesState]>()
  const windowPlacementChanged = emitter<[WindowPlacementState]>()
  let maximized = false
  let machinePreferences = { ...DEFAULT_MACHINE_PREFERENCES }
  const mockPreferencesKey = 'supraspinaMockMachinePreferences'
  const refreshMockPreferences = (): void => {
    try {
      const raw = localStorage.getItem(mockPreferencesKey)
      if (raw === null) {
        machinePreferences = { ...DEFAULT_MACHINE_PREFERENCES }
        return
      }
      machinePreferences = sanitizeMachinePreferences(JSON.parse(raw))
    } catch {
      machinePreferences = { ...DEFAULT_MACHINE_PREFERENCES }
    }
  }
  const persistMockPreferences = (): void => {
    try {
      localStorage.setItem(
        mockPreferencesKey,
        JSON.stringify(machinePreferences),
      )
    } catch {
      // Keep preferences in memory when browser storage is unavailable.
    }
  }
  const mockDisplayId = 'display-000000000000000000000000'
  let placementPreference: WindowPlacementPreference = { mode: 'remember' }
  const resolvedTheme = (): 'light' | 'dark' =>
    machinePreferences.theme === 'system'
      ? typeof matchMedia === 'function' &&
        matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : machinePreferences.theme
  const currentPreferences = (): MachinePreferencesState => {
    refreshMockPreferences()
    return {
      preferences: { ...machinePreferences },
      resolvedTheme: resolvedTheme(),
    }
  }
  const currentPlacement = (): WindowPlacementState => ({
    preference: placementPreference,
    displays: [
      {
        id: mockDisplayId,
        number: 1,
        primary: true,
        resolution: { width: 1920, height: 1080 },
        workArea: { width: 1920, height: 1040 },
        scaleFactor: 1,
        label: 'Browser display',
      },
    ],
    resolvedDisplayId: mockDisplayId,
    fallbackReason: null,
  })
  const updateStatus = emitter<[UpdateState]>()
  // Report the benign disabled state because the mock cannot reach an update feed.
  const disabledUpdateState: UpdateState = {
    phase: 'not-available',
    version: null,
    releaseNotes: null,
    percent: null,
    error: null,
    capability: 'noop',
  }
  const currentHostState = (): HostState => ({
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
      runtimeId: 'browser-mock',
      projectAttached,
      retryable: false,
      detail: null,
    },
  })

  const previewFor = (key: StepKey, subjectId?: string): string => {
    const subj = subjectId ?? '${subject}'
    switch (key) {
      case 'recon':
        return `recon-all -s ${subj} -i <T1> -sd <derivatives>/freesurfer -all -parallel -openmp 6`
      case 'enigma':
        return `sh enigma_fs_wrapper_script.sh --subjects subjects.txt --matlab matlab --fs_version 7`
      default:
        return `# ${key}: command resolved by the sidecar against installed tools`
    }
  }

  const mockDigest = (seed: string): string => {
    let value = 0x811c9dc5
    for (let index = 0; index < seed.length; index += 1) {
      value ^= seed.charCodeAt(index)
      value = Math.imul(value, 0x01000193)
    }
    return (value >>> 0).toString(16).padStart(8, '0').repeat(8)
  }

  const refFor = (root: string, epoch: number): ProjectRef => ({
    projectId: `mock:${root || 'untitled'}`,
    root,
    configPath: root ? `${root}/supraspina.project.json` : '',
    epoch,
  })

  const cohortQcDigest = (): string =>
    mockDigest(
      JSON.stringify(
        cohort.map(({ id, qc, analysisEligible }) => ({
          id,
          qc,
          analysisEligible,
        })),
      ),
    )

  /**
   * Refuse a plan before any node is planned, as the sidecar planner does
   * when the cohort cannot be resolved (workflow.py _blocked_result): no
   * nodes, empty cohorts and exclusions, zero counts, and the reason as the
   * summary.
   */
  const cohortRefusal = (
    request: WorkflowRequest,
    reason: string,
  ): WorkflowResult => {
    const summary = {
      planned: 0,
      started: 0,
      waiting: 0,
      blocked: 0,
      skipped: 0,
      message: reason,
    }
    const digest = mockDigest(
      JSON.stringify({ intent: request.intent, reason }),
    )
    return {
      runId: null,
      disposition: 'blocked',
      plan: {
        planId: `run-${digest.slice(0, 12)}`,
        digest,
        configDigest: mockDigest(JSON.stringify(request.cfg)),
        qcDigest: cohortQcDigest(),
        registryDigest: mockDigest('browser-mock-registry'),
        environmentDigest: mockDigest('browser-mock-environment'),
        analysisCohort: { subjectIds: [], sha256: 'mock-analysis-' },
        selectedSubset: { subjectIds: [], sha256: 'mock-selected-' },
        exclusions: { qcFailedSubjectIds: [], configExcludedSubjectIds: [] },
        resources: {
          queueSize: Math.max(1, request.cfg.runtime.queueSize),
          availableMemoryGB: 16,
          memoryWarningGB: 10,
          lowMemory: false,
        },
        nodes: [],
        blockers: [
          {
            key:
              request.intent.kind === 'stage'
                ? request.intent.stepKey
                : 'recon',
            kind: 'cohort',
            reason,
          },
        ],
        summary,
      },
      summary,
    }
  }

  const makePlan = (request: WorkflowRequest): WorkflowResult => {
    const analysis = cohort.filter(isAnalysisEligible)
    // The sidecar resolves the cohort in this order and refuses the plan at
    // the first failure: pending QC without acknowledgement, then an unsafe
    // or outside selection (cohort.py build_cohort_snapshot).
    const pendingQc = analysis.filter(
      (subject) => subject.qc === 'defer' || subject.qc === null,
    ).length
    if (
      pendingQc > 0 &&
      !request.acknowledgements.includeDeferredAndUnreviewedQc
    ) {
      return cohortRefusal(
        request,
        `Review ${pendingQc} deferred or unreviewed analysis subject(s); provide explicit acknowledgment.`,
      )
    }
    const stageKey =
      request.intent.kind === 'stage' ? request.intent.stepKey : null
    // A cohort stage always reads the whole analysis cohort, so the sidecar
    // ignores a route's subject selection for it.
    const target =
      stageKey !== null && STEP_SCOPES[stageKey] === 'cohort'
        ? ({ mode: 'all' } as const)
        : request.intent.target
    if (target.mode === 'explicit') {
      if (
        target.subjectIds.some(
          (id) =>
            typeof id !== 'string' ||
            id.length === 0 ||
            /[/\\\0]/.test(id) ||
            id.includes('..'),
        )
      ) {
        return cohortRefusal(
          request,
          'Provide only safe subject IDs in the selection.',
        )
      }
      const analysisIds = new Set(analysis.map((subject) => subject.id))
      const unknown = new Set(
        target.subjectIds.filter((id) => !analysisIds.has(id)),
      ).size
      if (unknown > 0) {
        return cohortRefusal(
          request,
          `Remove ${unknown} subject(s) outside the analysis cohort.`,
        )
      }
    }
    // After the selection checks the sidecar refuses an empty analysis
    // cohort (workflow.py), such as one where every subject failed QC.
    if (cohort.length > 0 && analysis.length === 0) {
      return cohortRefusal(request, 'Add subjects to the analysis cohort.')
    }
    // Known divergence: the sidecar refuses that same way for a project with
    // no subjects. The Runs and Logs screen tests plan against the unseeded
    // default mock, so the mock still plans for an unseeded cohort until
    // those fixtures seed one.
    const unseededCohort = cohort.length === 0
    const selected =
      target.mode === 'all'
        ? analysis
        : analysis.filter((subject) =>
            new Set(target.subjectIds).has(subject.id),
          )
    const explicitEmpty =
      request.intent.kind === 'workflow' &&
      target.mode === 'explicit' &&
      selected.length === 0
    const selectedSteps = stageKey
      ? PIPELINE_STEPS.filter((step) => step.key === stageKey)
      : PIPELINE_STEPS
    const nodes = [] as WorkflowResult['plan']['nodes']
    if (!explicitEmpty) {
      for (const step of selectedSteps) {
        if (!request.cfg.steps[step.key]?.enabled) {
          // The sidecar plans a stage that is off as skipped nodes, one per
          // selected subject or one cohort node, never as a blocker.
          const subjectIds =
            step.scope === 'subject'
              ? selected.map((subject) => subject.id)
              : [null]
          for (const subjectId of subjectIds) {
            nodes.push({
              nodeId: `${step.key}:${subjectId ?? 'cohort'}`,
              stepKey: step.key,
              scope: step.scope,
              subjectId,
              status: 'skipped',
              dependencies: [],
              reason: `${step.name} is off in project configuration.`,
            })
          }
          continue
        }
        if (step.scope === 'subject') {
          for (const subject of selected) {
            const dependencies = dependenciesForStep(
              step.key,
              request.cfg.steps.deface?.enabled === true,
              request.cfg.steps.brainfov?.enabled === true,
            ).map((key) => `${key}:${subject.id}`)
            nodes.push({
              nodeId: `${step.key}:${subject.id}`,
              stepKey: step.key,
              scope: step.scope,
              subjectId: subject.id,
              status: 'planned',
              dependencies,
              command: previewFor(step.key, subject.id),
            })
          }
        } else {
          const dependencies = dependenciesForStep(
            step.key,
            request.cfg.steps.deface?.enabled === true,
            request.cfg.steps.brainfov?.enabled === true,
          ).flatMap((key) =>
            STEP_SCOPES[key] === 'subject'
              ? analysis.map((subject) => `${key}:${subject.id}`)
              : [`${key}:cohort`],
          )
          nodes.push({
            nodeId: `${step.key}:cohort`,
            stepKey: step.key,
            scope: step.scope,
            subjectId: null,
            status: 'planned',
            dependencies,
            command: previewFor(step.key),
          })
        }
      }
    }
    const planned = nodes.filter((node) => node.status === 'planned').length
    const skipped = nodes.filter((node) => node.status === 'skipped').length
    // The sidecar's wording (workflow_manager.py _state_summary for a plan
    // with nodes; workflow.py for one without). The mock plans no blocked
    // or waiting node, so the blocked-node lead-ins never apply here.
    const summary = {
      planned,
      started: 0,
      waiting: 0,
      blocked: 0,
      skipped,
      message: explicitEmpty
        ? 'Keep the explicit empty workflow target as a no-op.'
        : nodes.length === 0
          ? 'Review plan totals: planned 0; waiting 0; blocked 0; skipped 0.'
          : planned === 0
            ? skipped === 1
              ? 'No work is scheduled: the 1 node is current.'
              : `No work is scheduled: all ${skipped} nodes are current.`
            : request.cfg.runtime.dryRun
              ? 'The run is planned.'
              : 'The run is queued.',
    }
    const configDigest = mockDigest(JSON.stringify(request.cfg))
    const qcDigest = cohortQcDigest()
    const registryDigest = mockDigest('browser-mock-registry')
    const environmentDigest = mockDigest('browser-mock-environment')
    const materialDigest = mockDigest(
      JSON.stringify({
        intent: request.intent,
        acknowledgements: request.acknowledgements,
        configDigest,
        qcDigest,
        registryDigest,
        environmentDigest,
        selectedSubjectIds: selected.map((subject) => subject.id),
        nodes,
      }),
    )
    return {
      runId: null,
      disposition:
        planned > 0 || (unseededCohort && !explicitEmpty) ? 'planned' : 'noop',
      plan: {
        planId: `run-${materialDigest.slice(0, 12)}`,
        digest: materialDigest,
        configDigest,
        qcDigest,
        registryDigest,
        environmentDigest,
        analysisCohort: {
          subjectIds: analysis.map((subject) => subject.id),
          sha256: `mock-analysis-${analysis.map((subject) => subject.id).join('-')}`,
        },
        selectedSubset: {
          subjectIds: selected.map((subject) => subject.id),
          sha256: `mock-selected-${selected.map((subject) => subject.id).join('-')}`,
        },
        exclusions: {
          qcFailedSubjectIds: cohort
            .filter((subject) => subject.qc === 'fail')
            .map((subject) => subject.id),
          configExcludedSubjectIds: cohort
            .filter(
              (subject) =>
                subject.qc !== 'fail' && !isAnalysisEligible(subject),
            )
            .map((subject) => subject.id),
        },
        resources: {
          queueSize: Math.max(1, request.cfg.runtime.queueSize),
          availableMemoryGB: 16,
          memoryWarningGB: 10,
          lowMemory: false,
        },
        nodes,
        blockers: [],
        advisories: mockPlanAdvisories(analysis, nodes),
        summary,
      },
      summary,
    }
  }

  const startWorkflow = (request: WorkflowRequest): WorkflowResult => {
    const result = makePlan(request)
    if (result.disposition === 'noop' || result.disposition === 'blocked')
      return result
    if (
      request.approvedPlan?.planId !== result.plan.planId ||
      request.approvedPlan.digest !== result.plan.digest
    ) {
      throw new Error(
        'Review the approved workflow plan again because it is stale.',
      )
    }
    const dryRun = request.cfg.runtime.dryRun
    const runId = dryRun ? result.plan.planId : `mock-run-${++runCounter}`
    const now = Date.now()
    const runnable = result.plan.nodes.filter((node) =>
      dryRun
        ? node.status === 'planned' || node.status === 'waiting'
        : node.status === 'planned',
    )
    runtimeJobs = runnable.map((node) => ({
      id: `#${++jobCounter}`,
      runId,
      nodeId: node.nodeId,
      projectId: request.project.projectId,
      projectEpoch: request.project.epoch,
      sidecarGeneration: 1,
      stepKey: node.stepKey,
      subjectId: node.subjectId,
      scope: node.scope,
      plannedAt: now,
      startedAt: null,
      endedAt: dryRun ? now : null,
      exitCode: null,
      cmd: node.command ?? '',
      stdoutPath: '',
      stderrPath: '',
      envSnapshotPath: '',
      configSnapshotPath: '',
      status: dryRun ? 'planned' : 'queued',
      dryRun,
      durable: true,
      persistenceStatus: 'durable',
      terminalReason: dryRun ? 'dry_run' : null,
    }))
    // The sidecar's wording (workflow_manager.py start): the result says
    // what the launch did, and the run record keeps its state summary.
    const count = runtimeJobs.length
    const plural = count === 1 ? '' : 's'
    const summary = {
      ...result.summary,
      started: dryRun ? 0 : count,
      message: dryRun
        ? `Dry run only: planned ${count} command${plural} and executed nothing. Turn off Dry run first to execute.`
        : `Started run ${runId}: ${count} job${plural} queued. Watch In flight here and the output in Logs.`,
    }
    runtimeRuns = [
      {
        runId,
        projectId: request.project.projectId,
        projectEpoch: request.project.epoch,
        status: dryRun ? 'planned' : 'queued',
        startedAt: now,
        endedAt: dryRun ? now : null,
        dryRun,
        durable: true,
        analysisSubjectIds: [...result.plan.analysisCohort.subjectIds],
        selectedSubjectIds: [...result.plan.selectedSubset.subjectIds],
        acknowledgements: request.acknowledgements,
        summary: {
          ...summary,
          message: dryRun ? 'The run is planned.' : 'The run is queued.',
        },
      },
      ...runtimeRuns,
    ]
    for (const job of runtimeJobs) {
      jobUpdate.emit(job)
      runtimeEvent.emit({
        kind: 'job',
        projectId: request.project.projectId,
        projectEpoch: request.project.epoch,
        sidecarGeneration: 1,
        sequence: ++runtimeSequence,
        runId,
        at: now,
        job,
      })
    }
    return {
      ...result,
      runId,
      disposition: dryRun ? 'planned' : 'started',
      summary,
    }
  }

  // The documentation harness asks for the v2 results, newest first, so the
  // Analysis grid capture opens on one.
  const analysisV2 = ((): boolean => {
    try {
      return localStorage.getItem('supraspinaMockAnalysisV2') === '1'
    } catch {
      return false
    }
  })()
  const { groupAnalysis, brainViewer } = createMockGroupAnalysis(
    () => currentProject.root,
    analysisV2 ? { listV2Results: true, v2First: true } : {},
  )

  return {
    groupAnalysis,
    brainViewer,
    atlasSources: createMockAtlasSources(),
    project: {
      create: async ({ at, cfg, epoch }) => {
        currentCfg = cfg
        currentProject = refFor(at, epoch)
        projectAttached = true
        hostState.emit(currentHostState())
        return {
          project: currentProject,
          cfg,
          configSha256: '0'.repeat(64),
        }
      },
      open: async ({ path, epoch }) => {
        const root = path.replace(/\/[^/]*$/, '')
        currentProject = refFor(root, epoch)
        currentCfg = {
          ...currentCfg,
          paths: { ...currentCfg.paths, projectRoot: root },
        }
        projectAttached = true
        hostState.emit(currentHostState())
        return {
          project: currentProject,
          cfg: currentCfg,
          configSha256: '0'.repeat(64),
        }
      },
      close: async () => {
        projectAttached = false
        hostState.emit(currentHostState())
      },
      save: async ({ project, cfg, configRevision }) => {
        currentProject = project
        currentCfg = cfg
        return { project, configRevision, sha256: '0'.repeat(64) }
      },
      validate: async (cfg: ProjectConfig) => {
        const v = validateProjectConfig(cfg)
        return { errors: v.errors, warnings: v.warnings }
      },
    },
    host: {
      getState: async () => currentHostState(),
      retrySidecar: async () => undefined,
      onState: (cb) => hostState.on(cb),
    },
    preferences: {
      get: async () => currentPreferences(),
      patch: async (patch) => {
        refreshMockPreferences()
        const safe = validateMachinePreferencesPatch(patch)
        machinePreferences = sanitizeMachinePreferences({
          ...machinePreferences,
          ...safe,
        })
        persistMockPreferences()
        const state = currentPreferences()
        preferencesChanged.emit(state)
        return state
      },
      reset: async () => {
        machinePreferences = { ...DEFAULT_MACHINE_PREFERENCES }
        persistMockPreferences()
        placementPreference = { mode: 'remember' }
        const preferencesState = currentPreferences()
        preferencesChanged.emit(preferencesState)
        windowPlacementChanged.emit(currentPlacement())
        return preferencesState
      },
      onChanged: (cb) => preferencesChanged.on(cb),
    },
    windowPlacement: {
      getState: async () => currentPlacement(),
      setPreference: async (preference) => {
        if (
          preference.mode === 'display' &&
          preference.displayId !== mockDisplayId
        ) {
          throw new Error('Select a connected display.')
        }
        placementPreference = preference
        const state = currentPlacement()
        windowPlacementChanged.emit(state)
        return state
      },
      moveNow: async () => currentPlacement(),
      identifyDisplays: async () => undefined,
      onTopologyChanged: (cb) => windowPlacementChanged.on(cb),
    },
    platform: {
      detect: async (): Promise<PlatformMode> => 'linux',
      cpuCount: async () =>
        typeof navigator !== 'undefined' &&
        Number.isFinite(navigator.hardwareConcurrency)
          ? navigator.hardwareConcurrency
          : 24,
      toNative: async (p) => p,
      fromNative: async (p) => p,
    },
    fs: {
      chooseDir: async () => null,
      chooseFile: async () => null,
      chooseSavePath: async () => null,
    },
    external: {
      openWeb: async () => undefined,
      openThirdPartyNotices: async () => undefined,
    },
    execution: {
      authorize: async ({ project, configRevision, purpose, planDigest }) => ({
        token: `mock-authorization-${purpose}-${Date.now()}`,
        projectId: project.projectId,
        configRevision,
        purpose,
        ...(planDigest ? { planDigest } : {}),
      }),
    },
    artifact: {
      open: async ({ artifactId, focusText }) => {
        const openedAt = new Date().toISOString()
        const tab = artifactId.includes('external')
          ? 'external'
          : artifactId.includes('internal')
            ? 'internal'
            : 'subcortical'
        return {
          openedAt,
          reviewGrant: focusText
            ? {
                grantId: mockDigest(`${artifactId}\0${focusText}\0${openedAt}`),
                tab,
                subjectId: focusText,
                inventoryRunId: 'run-12345678',
                runId: 'run-12345678',
                receiptSha256: '1'.repeat(64),
                openedAt,
                expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              }
            : null,
        }
      },
      reveal: async () => undefined,
      list: async (): Promise<ResultPage> => ({
        items: [],
        nextCursor: null,
        truncated: false,
      }),
      readText: async () => ({ text: '', truncated: false }),
      previewImage: async () => ({
        dataUrl: MOCK_PNG_DATA_URL,
        mimeType: 'image/png',
        truncated: false,
      }),
    },
    qc: {
      authoritativeRun: async () => ({
        runId: 'run-12345678',
        unavailable: null,
        // Leave the mock inventory uncached so each view reads it afresh.
        inventoryKey: null,
      }),
      galleryImages: async ({ artifactId, subjectId }) => {
        const tab = qcTabForArtifact(artifactId)
        return {
          tab,
          subjectId,
          runId: 'run-12345678',
          receiptSha256: '1'.repeat(64),
          inventoryRunId: 'run-12345678',
          panels: mockGalleryPanels(tab, subjectId),
        }
      },
      attestGalleryView: async ({ artifactId, subjectId }) => {
        const openedAt = new Date().toISOString()
        return {
          reviewGrant: {
            grantId: mockDigest(`${artifactId}\0${subjectId}\0${openedAt}`),
            tab: qcTabForArtifact(artifactId),
            subjectId,
            inventoryRunId: 'run-12345678',
            runId: 'run-12345678',
            receiptSha256: '1'.repeat(64),
            openedAt,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        }
      },
    },
    env: {
      check: async () => mockEnvReport(hostReadiness()),
      // Model the sidecar operation: return an identity now, then publish the
      // running and terminal phases so the preview shows real install state.
      optInInstall: async ({ project, checkId }) => {
        const operationId = `install-${mockDigest(String(++jobCounter)).slice(0, 12)}`
        const startedAt = Date.now()
        const base = {
          operationId,
          checkId,
          projectId: project.projectId,
          projectEpoch: project.epoch,
          startedAt,
          rc: null,
          stdout: '',
          stderr: '',
        }
        publishEnvInstall({
          ...base,
          phase: 'queued',
          updatedAt: startedAt,
          output: '',
        })
        setTimeout(() => {
          publishEnvInstall({
            ...base,
            phase: 'running',
            updatedAt: Date.now(),
            output: 'Collecting the requested package\n',
          })
        }, 200)
        setTimeout(() => {
          publishEnvInstall({
            ...base,
            phase: 'done',
            updatedAt: Date.now(),
            output: 'Collecting the requested package\nInstalled\n',
            rc: 0,
            stdout: 'Complete the mock installation.',
          })
        }, 1200)
        return { operationId }
      },
      installStatus: async ({ project }) => ({
        operations: envInstalls.filter(
          (item) =>
            item.projectId === project.projectId &&
            item.projectEpoch === project.epoch,
        ),
      }),
      createOutputDir: async ({ cfg }): Promise<EnvCreateDirResult> => ({
        ok: true,
        detail: `Created ${cfg.paths.derivativesDir}/freesurfer.`,
      }),
      toolStatus: async ({ cfg }): Promise<ToolStatus> =>
        mockToolStatus(cfg, hostReadiness()),
      onInstallProgress: (cb) => envInstallProgress.on(cb),
    },
    provision: {
      pybrainage: async ({ project, configRevision }) => {
        const operationId = `provision-${++jobCounter}`
        // The adapter's own step lines and the sidecar's closing message
        // (execute_provision and provisioning.py), which the renderer states
        // as facts. The sidecar streams each message as an output line and
        // then as progress, before the step's own output.
        const steps: readonly {
          phase: ProvisionProgress['phase']
          percent: number
          message: string
          output: readonly string[]
        }[] = [
          {
            phase: 'env',
            percent: 10,
            message: 'Run create_env.',
            output: [
              '$ micromamba create --yes --prefix envs/pybrainage --file conda-linux-64.lock',
              'Transaction finished',
              '[exit 0]',
            ],
          },
          {
            phase: 'env',
            percent: 20,
            message: 'Run install_pip_deps.',
            output: [
              '$ envs/pybrainage/bin/python -m pip install --require-hashes -r pip.lock',
              'Successfully installed cliffs-delta-1.0.0',
              '[exit 0]',
            ],
          },
          {
            phase: 'download',
            percent: 40,
            message: 'Run fetch_model.',
            output: [],
          },
          {
            phase: 'validate',
            percent: 70,
            message: 'Run validate_pickle.',
            output: [],
          },
          {
            phase: 'done',
            percent: 100,
            message: 'PyBrainAge provisioning is complete.',
            output: [],
          },
        ]
        mockProvisionStatus = {
          envReady: true,
          modelReady: true,
          pythonExecutable: `${currentCfg.paths.outputDir}/.pybrainage/current/envs/pybrainage/bin/python`,
          modelPath: `${currentCfg.paths.outputDir}/.pybrainage/current/pybrainage/v3/software/ExtraTreesModel`,
          scalerPath: `${currentCfg.paths.outputDir}/.pybrainage/current/pybrainage/v3/software/scaler.pkl`,
          projectId: project.projectId,
          projectEpoch: project.epoch,
          configRevision,
          operationId,
          phase: 'done',
          cancellable: false,
          error: null,
        }
        const operation = {
          projectId: project.projectId,
          projectEpoch: project.epoch,
          operationId,
        }
        for (const { phase, percent, message, output } of steps) {
          provisionLog.emit({ ...operation, at: Date.now(), line: message })
          progress.emit({ ...operation, phase, percent, message })
          for (const line of output) {
            provisionLog.emit({ ...operation, at: Date.now(), line })
          }
        }
        return { operationId }
      },
      // Model the sidecar: the renderer accepted the license notice, and the
      // setup publishes its steps and then reports the checks as found.
      braincharts: async ({ project, licenseAccepted }) => {
        if (licenseAccepted !== true) {
          throw new Error(
            'Accept the BrainCharts license notice before the download.',
          )
        }
        const operationId = `provision-${mockDigest(String(++jobCounter)).slice(0, 12)}`
        const operation = {
          projectId: project.projectId,
          projectEpoch: project.epoch,
          operationId,
        }
        const steps: Array<Omit<ProvisionProgress, keyof typeof operation>> = [
          {
            phase: 'env',
            percent: 15,
            message: 'Installing the locked pcntoolkit runtime (about 2 GB)...',
          },
          {
            phase: 'download',
            percent: 38,
            message: 'Downloading the BrainCharts model from GitHub...',
          },
          {
            phase: 'validate',
            percent: 77,
            message: 'Loading one model with pcntoolkit...',
          },
          {
            phase: 'done',
            percent: 100,
            message: 'BrainCharts setup is complete.',
          },
        ]
        mockBrainChartsReady = true
        for (const step of steps) {
          provisionLog.emit({
            ...operation,
            at: Date.now(),
            line: step.message,
          })
          progress.emit({ ...operation, ...step })
        }
        return { operationId }
      },
      synthstrip: async () => ({
        operationId: `resource-${mockDigest(String(++jobCounter)).slice(0, 12)}`,
      }),
      fastsurfer: async () => ({
        operationId: `resource-${mockDigest(String(++jobCounter)).slice(0, 12)}`,
      }),
      status: async ({ project }): Promise<ProvisionStatus> =>
        mockProvisionStatus?.projectId === project.projectId &&
        mockProvisionStatus.projectEpoch === project.epoch
          ? mockProvisionStatus
          : {
              envReady: false,
              modelReady: false,
              pythonExecutable: null,
              modelPath: null,
              scalerPath: null,
              projectId: project.projectId,
              projectEpoch: project.epoch,
              configRevision: 0,
              operationId: null,
              phase: 'idle',
              cancellable: false,
              error: null,
            },
      cancel: async ({ operationId }) => ({
        operationId,
        accepted: true,
        terminal: true,
      }),
      onProgress: (cb) => progress.on(cb),
      onLog: (cb) => provisionLog.on(cb),
    },
    managedResource: {
      status: async ({
        resource,
        variant,
      }): Promise<ManagedResourceStatusResult> => {
        const lifecycle = {
          state: 'missing' as const,
          phase: 'idle' as const,
          operationId: null,
          percent: null,
          cancellable: false,
          error: null,
          // Present the browser preview as a host that can pull, so the
          // readiness row does not imply a broken machine outside Electron.
          runtime: {
            found: true,
            path: '/usr/bin/apptainer',
            version: '1.5.3',
            expectedVersion: '1.5.3',
            ready: true,
            detail: null,
          },
        }
        return resource === 'synthstrip'
          ? {
              resource,
              variant: 'cpu',
              version: '1.8',
              ...lifecycle,
            }
          : {
              resource,
              variant,
              version: '2.5.4',
              ...lifecycle,
            }
      },
      cancel: async ({ operationId }) => ({
        operationId,
        accepted: true,
        terminal: true,
      }),
      importOffline: async () => ({
        operationId: `resource-${mockDigest(String(++jobCounter)).slice(0, 12)}`,
      }),
      onProgress: (cb) => managedResourceProgress.on(cb),
    },
    inputFov: {
      list: async ({ configRevision }) => ({
        configRevision,
        items: [],
      }),
      review: async ({
        configRevision,
        expectedRevision,
        decision,
        subjectId,
        acquisitionId,
        preflightSignature,
        sourceSha256,
        outputSha256,
      }) => ({
        decision,
        revision: expectedRevision + 1,
        configRevision,
        reviewedAt: new Date().toISOString(),
        decisionSignature: mockDigest(
          JSON.stringify({
            subjectId,
            acquisitionId,
            preflightSignature,
            sourceSha256,
            outputSha256,
            decision,
          }),
        ),
        current: true,
      }),
    },
    surfaceRegistration: {
      status: async () =>
        mockSurfaceRegistrationStatus(cohort, registrationOperation),
      check: async () => {
        const total = mockSurfaceRegistrationStatus(cohort, null).counts.checked
        const now = new Date().toISOString()
        registrationOperation = {
          operationId: `srg-${mockDigest(now).slice(0, 16)}`,
          state: 'done',
          total,
          completed: total,
          failed: 0,
          startedAt: now,
          finishedAt: now,
          message: null,
        }
        return { operation: registrationOperation, started: true }
      },
      cancel: async ({ operationId }) => ({ operationId, stopped: false }),
    },
    subjects: {
      discover: async () => cohort,
      refreshOne: async ({ subjectId }) => {
        const found = cohort.find((s) => s.id === subjectId)
        if (!found) throw new Error(`Provide a known subject: ${subjectId}.`)
        return found
      },
      openFolder: async () => undefined,
      openLog: async () => undefined,
      exportCsv: async () => undefined,
      markQc: async ({ subjectId, verdict, note, tags }) => {
        const existing = cohort.find((subject) => subject.id === subjectId)
        const revision = (existing?.qcRevision ?? 0) + 1
        cohort = cohort.map((s) =>
          s.id === subjectId
            ? {
                ...s,
                qc: verdict,
                notes: note,
                qcTags: tags,
                qcRevision: revision,
                analysisEligible: verdict !== 'fail',
                unavailableReason:
                  verdict === 'fail' ? QC_FAIL_EXCLUSION_REASON : null,
              }
            : s,
        )
        return {
          subjectId,
          verdict,
          note,
          tags,
          reviewEvidence: null,
          revision,
          updatedAt: new Date().toISOString(),
        }
      },
    },
    registry: {
      list: async () => registryRows,
      upsert: async ({ record, expectedRevision }) => {
        const previous = registryRows.find(
          (row) => row.subjectId === record.subjectId,
        )
        if (
          expectedRevision !== undefined &&
          previous?.revision !== expectedRevision
        ) {
          throw new Error(
            'Load saved values because another writer changed this record.',
          )
        }
        return applyRegistryRecord(record)
      },
      chooseImportCsv: async () => ({
        name: 'registry-import-example.csv',
        displayPath: '/mock/registry-import-example.csv',
        text: REGISTRY_IMPORT_EXAMPLE_CSV,
      }),
      importCsv: async ({ csvText, onExisting }) => {
        const lines = csvText
          .split(/\r?\n/)
          .filter((line) => line.trim() !== '')
        const header = lines[0]?.replace(/^\ufeff/, '') ?? ''
        const errors: RegistryImportIssue[] = []
        const warnings: RegistryImportIssue[] = []
        // Like the sidecar, the site column is optional.
        const siteColumn = header === REGISTRY_IMPORT_COLUMNS.join(',')
        if (
          !siteColumn &&
          header !== REGISTRY_IMPORT_COLUMNS.slice(0, -1).join(',')
        ) {
          errors.push({
            row: 1,
            message: `Use the documented header: ${REGISTRY_IMPORT_COLUMNS.join(',')}.`,
          })
        }
        const candidates = errors.length > 0 ? [] : lines.slice(1)
        const rows = candidates.map((line, index) => {
          const row = index + 2
          const [
            subjectId = '',
            age = '',
            sex = '',
            sourceCohortLabel = '',
            ais = '',
            tSinceSci = '',
            site = '',
          ] = line.split(',').map((cell) => cell.trim())
          if (!/^sub-[A-Za-z0-9]{1,124}$/.test(subjectId)) {
            errors.push({
              row,
              message: 'Use a BIDS subject label such as sub-001 or sub-0004.',
            })
          }
          const record: RegistryInput = {
            subjectId,
            age: age === '' ? null : Number(age),
            sex: sex === 'M' || sex === 'F' || sex === 'O' ? sex : 'O',
            sourceCohortLabel,
            ais:
              ais === 'A' || ais === 'B' || ais === 'C' || ais === 'D'
                ? ais
                : null,
            tSinceSci: tSinceSci === '' ? null : Number(tSinceSci),
            ...(siteColumn ? { site: site === '' ? null : site } : {}),
          }
          return { row, record }
        })
        let imported = 0
        let updated = 0
        let skipped = 0
        if (errors.length === 0) {
          for (const { row, record } of rows) {
            const existing = registryRows.find(
              (item) => item.subjectId === record.subjectId,
            )
            if (existing && onExisting === 'skip') {
              skipped += 1
              warnings.push({
                row,
                message: `Kept the existing record for ${record.subjectId} and skipped the row.`,
              })
              continue
            }
            applyRegistryRecord(record)
            if (existing) {
              updated += 1
              warnings.push({
                row,
                message: `Replaced the existing record for ${record.subjectId}.`,
              })
            } else {
              imported += 1
            }
          }
        }
        const applied = errors.length === 0
        const result: RegistryImportResult = {
          applied,
          imported,
          updated,
          skipped,
          errors,
          warnings: applied ? warnings : [],
          errorTotal: errors.length,
          warningTotal: applied ? warnings.length : 0,
        }
        return result
      },
      saveExampleCsv: async () => undefined,
      remove: async ({ subjectId }) => {
        registryRows = registryRows.filter((row) => row.subjectId !== subjectId)
      },
      setSite: async (request) => {
        const { subjectIds, site, expectedRevisions } =
          parseRegistrySetSiteFields(request)
        const targets = subjectIds.map((subjectId) =>
          registryRows.find((row) => row.subjectId === subjectId),
        )
        // A subject without a record has revision 0 and its site is held.
        if (
          subjectIds.some(
            (subjectId, index) =>
              (targets[index]?.revision ?? 0) !== expectedRevisions[subjectId],
          )
        ) {
          throw new Error(
            'Load saved values because another writer changed this record.',
          )
        }
        const conflict =
          site === null
            ? null
            : siteLabelConflict(site, [
                ...registryRows.flatMap((row) => (row.site ? [row.site] : [])),
                ...heldSites.values(),
              ])
        if (conflict !== null) {
          throw new Error(
            `Use the existing site label ${conflict}; the two labels differ only in letter case.`,
          )
        }
        const updatedAt = new Date().toISOString()
        const named = new Set(subjectIds)
        registryRows = registryRows.map((row) =>
          named.has(row.subjectId)
            ? { ...row, site, revision: row.revision + 1, updatedAt }
            : row,
        )
        subjectIds.forEach((subjectId, index) => {
          if (targets[index]) return
          if (site === null) heldSites.delete(subjectId)
          else heldSites.set(subjectId, site)
        })
        cohort = cohort.map((subject) =>
          named.has(subject.id) ? { ...subject, site } : subject,
        )
        return { site, updated: subjectIds.length }
      },
    },
    pipeline: {
      listSteps: async (): Promise<StepDescriptor[]> =>
        PIPELINE_STEPS.map((s) => ({
          id: s.id,
          key: s.key,
          name: s.name,
          goal: s.goal,
          scope: s.scope,
          dependencies: [...dependenciesForStep(s.key, false, false)],
        })),
      previewCommand: async (_cfg, key, subjectId) =>
        previewFor(key, subjectId),
      planWorkflow: async (request) => makePlan(request),
      runWorkflow: async (request) => startWorkflow(request),
      resumeWorkflow: async (request) =>
        startWorkflow({
          ...request,
          intent: { kind: 'workflow', target: { mode: 'all' } },
        }),
      retryWorkflow: async (request) =>
        startWorkflow({
          ...request,
          intent: { kind: 'workflow', target: { mode: 'all' } },
        }),
      cancelRun: async ({ runId }) => {
        runtimeJobs = runtimeJobs.map((job) =>
          job.runId === runId
            ? {
                ...job,
                status: 'cancelled',
                endedAt: Date.now(),
                terminalReason:
                  "This work was canceled at the operator's request.",
              }
            : job,
        )
        runtimeRuns = runtimeRuns.map((run) =>
          run.runId === runId
            ? { ...run, status: 'cancelled', endedAt: Date.now() }
            : run,
        )
        return {
          runId,
          accepted: true,
          terminal: true,
          pendingJobIds: [],
          message: 'Cancellation settled.',
        }
      },
      onJobUpdate: (cb) => jobUpdate.on(cb),
      onStdout: (cb) => stdout.on(cb),
    },
    runtime: {
      bootstrap: async ({ project }) => ({
        project,
        sidecarGeneration: 1,
        sequence: runtimeSequence,
        runs: runtimeRuns.filter((run) => run.projectId === project.projectId),
        jobs: runtimeJobs.filter((job) => job.projectId === project.projectId),
        logTail: runtimeLogs,
        // The mock keeps every line live and replays no committed log file.
        logReplay: [],
        provision: null,
      }),
      onEvent: (cb) => runtimeEvent.on(cb),
    },
    manifest: {
      forRun: async ({ runId }) => mockManifest(runId),
      list: async (): Promise<ManifestPage> => ({
        items: [],
        nextCursor: null,
      }),
      previewDebug: async ({ runId }) => ({
        runId,
        categories: [],
        totalFiles: 0,
        estimatedBytes: 0,
        redactionPolicy: 'Paths and subject identifiers are redacted.',
        truncated: false,
      }),
      bundleDebug: async ({ runId }) => ({
        artifactId: `debug:${runId}`,
        displayPath: `${runId}-debug.zip`,
      }),
    },
    results: {
      list: async ({ stepKey }): Promise<ResultPage> =>
        stepKey === 'enigma'
          ? {
              items: mockEnigmaGalleries(),
              nextCursor: null,
              truncated: false,
              runId: 'run-12345678',
            }
          : {
              items: [],
              nextCursor: null,
              truncated: false,
              // The stages the Analysis panel reads are judged current, so
              // its header and summary agree in the mock.
              stageCurrency: {
                aggregate: { state: 'current', outdatedSubjectIds: [] },
                pybrainage: { state: 'current', outdatedSubjectIds: [] },
              },
            },
    },
    lifecycle: {
      onBoundaryRequested: (cb) => lifecycleBoundary.on(cb),
      respondBoundary: async () => undefined,
    },
    window: {
      minimize: async () => undefined,
      toggleMaximize: async () => {
        maximized = !maximized
        windowMaximize.emit(maximized)
      },
      close: async () => undefined,
      isMaximized: async () => maximized,
      onMaximizeChange: (cb) => windowMaximize.on(cb),
    },
    update: {
      check: async () => ({
        available: false,
        version: null,
        releaseNotes: null,
      }),
      download: async () => undefined,
      installNow: async () => undefined,
      getStatus: async () => disabledUpdateState,
      onStatus: (cb) => updateStatus.on(cb),
    },
  }
}

/**
 * A valid 8x8 plain gray PNG, so mock previews decode like real artifacts and
 * show an empty placeholder tile rather than a picture.
 */
const MOCK_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAADklEQVR42mPQgwIGyhgAnlcLgbpWm14AAAAASUVORK5CYII='

/** The three ENIGMA QC galleries in protocol order. */
const MOCK_QC_GALLERIES = [
  {
    tab: 'subcortical' as const,
    label: 'Subcortical QC gallery',
    displayPath:
      'outputs/run/qc_review/qc/subcortical/ENIGMA_Subcortical_QC.html',
  },
  {
    tab: 'internal' as const,
    label: 'Cortical-internal QC gallery',
    displayPath:
      'outputs/run/qc_review/qc/cortical_internal/ENIGMA_Cortical_QC.html',
  },
  {
    tab: 'external' as const,
    label: 'Cortical-external QC gallery',
    displayPath:
      'outputs/run/qc_review/qc/cortical_external/ENIGMA_External_QC.html',
  },
]

/** Build the deterministic ENIGMA gallery inventory. */
function mockEnigmaGalleries(): ResultArtifact[] {
  return MOCK_QC_GALLERIES.map((gallery) => ({
    artifactId: `artifact:enigma:${gallery.tab}`,
    label: gallery.label,
    stepKey: 'enigma' as StepKey,
    subjectId: null,
    kind: 'html' as const,
    presence: 'produced' as const,
    displayPath: gallery.displayPath,
    exists: true,
    openable: true,
    revealable: true,
    runId: 'run-12345678',
    producerNodeId: 'enigma',
    receiptSha256: '1'.repeat(64),
    provenance: 'current' as const,
  }))
}

/** Resolve the protocol tab for a mock gallery artifact. */
function qcTabForArtifact(artifactId: string): QcGalleryView['tab'] {
  if (artifactId.includes('external')) return 'external'
  if (artifactId.includes('internal')) return 'internal'
  return 'subcortical'
}

/**
 * Build the montage panels described by the mock detector. Match the upstream
 * protocol with 12 subcortical slices, 16 internal-cortical slices, and four
 * external surfaces.
 */
function mockGalleryPanels(
  tab: QcGalleryView['tab'],
  subjectId: string,
): QcGalleryPanel[] {
  const image = (relative: string): QcGalleryImage => ({
    artifactId: `artifact:enigma:${tab}:${subjectId}:${relative}`,
    displayPath: `outputs/run/qc_review/qc/${tab}/${relative}`,
    bytes: 51_200,
    sha256: '2'.repeat(64),
  })
  if (tab === 'external') {
    return (['lh', 'rh'] as const).flatMap((hemisphere) =>
      (['lat', 'med'] as const).map((view) => {
        const relative = `${subjectId}.${hemisphere}.${view}.png`
        const group =
          hemisphere === 'lh' ? 'Left hemisphere' : 'Right hemisphere'
        const detail = view === 'lat' ? 'lateral' : 'medial'
        return {
          key: `${hemisphere}-${view}`,
          group,
          detail,
          label: `${group}, ${detail}`,
          montage: image(relative),
          full: image(relative),
        }
      }),
    )
  }
  const axes =
    tab === 'subcortical'
      ? (['Axial', 'Coronal', 'Sagittal'] as const)
      : (['Axial', 'Coronal'] as const)
  const slices =
    tab === 'subcortical'
      ? ['20', '40', '60', '80']
      : ['10', '20', '40', '50', '60', '80', '85', '90']
  const set = tab === 'subcortical' ? 'Subcortical' : 'Cortical'
  return axes.flatMap((axis) =>
    slices.map((percent) => ({
      key: `${axis.toLowerCase()}-${percent}`,
      group: axis,
      detail: `${percent}%`,
      label: `${axis} ${percent}%`,
      montage: image(`${subjectId}/${set}_set_${axis}_70_${percent}.png`),
      full: image(`${subjectId}/${set}_set_${axis}_${percent}.png`),
    })),
  )
}

/**
 * Install the mock API on `window.supraspina` if the real bridge is absent.
 *
 * @returns The existing bridge or the installed mock API.
 */
export function installMockSupraspina(): SupraspinaApi {
  const existing = (globalThis as { supraspina?: SupraspinaApi }).supraspina
  if (existing) return existing
  const api = createMockApi()
  ;(api as SupraspinaApi & { __mock?: true }).__mock = true
  ;(globalThis as { supraspina?: SupraspinaApi }).supraspina = api
  return api
}
