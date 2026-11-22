/**
 * Defines the canonical step model shared by the renderer and main/sidecar
 * orchestration layer.
 *
 * Two distinct taxonomies are reconciled here:
 *
 * 1. {@link MATRIX_STEPS} covers the ten per-subject status columns rendered
 *    in the Subjects matrix. The three ENIGMA QC substeps appear as separate
 *    columns, and manual age and clinical edits fold into downstream columns.
 *
 * 2. {@link PIPELINE_STEPS} covers the configurable pipeline stages addressed
 *    by `supraspina.project.json` (`steps.<key>`) and edited in the Pipeline
 *    screen. Each stage declares a parameter schema, input/output
 *    descriptors, and the matrix column that it advances.
 *
 * Each pipeline step's real command string and completion detector is computed
 * in the Python sidecar against the installed tool versions through
 * `pipeline.previewCommand`. Do not hardcode them here.
 */

// -----------------------------------------------------------------------------
// Model the ten matrix status columns.
// -----------------------------------------------------------------------------

/** The identity of one fixed subject-matrix status column. */
export type MatrixStepKey =
  | 'recon'
  | 'qcsub'
  | 'qcic'
  | 'qcec'
  | 'feat'
  | 'pba'
  | 'norm'
  | 'stats'
  | 'agg'
  | 'rep'

/** One fixed subject-matrix status column. */
export interface MatrixStep {
  readonly key: MatrixStepKey
  readonly label: string
  readonly long: string
  readonly dur: number
}

/**
 * The ten matrix columns in this load-bearing order. Use this order
 * to index the matrix columns, resume at the first incomplete step, and populate
 * the single-step picker.
 */
export const MATRIX_STEPS: readonly MatrixStep[] = [
  { key: 'recon', label: 'Reconstruction', long: 'recon-all', dur: 18000 },
  { key: 'qcsub', label: 'QC Sub', long: 'enigma.qc.subcort', dur: 5000 },
  { key: 'qcic', label: 'QC IC', long: 'enigma.qc.intCort', dur: 5000 },
  { key: 'qcec', label: 'QC EC', long: 'enigma.qc.extCort', dur: 5000 },
  { key: 'feat', label: 'Feat', long: 'features.extract', dur: 7000 },
  { key: 'pba', label: 'PBA', long: 'pybrainage.predict', dur: 8000 },
  { key: 'norm', label: 'Norm', long: 'braincharts.zscores', dur: 8000 },
  { key: 'stats', label: 'Stats', long: 'stats.glm', dur: 6000 },
  { key: 'agg', label: 'Agg', long: 'aggregate.cohort', dur: 4000 },
  { key: 'rep', label: 'Report', long: 'report.html', dur: 3000 },
] as const

/** The count of fixed subject-matrix status columns. */
export const MATRIX_STEP_COUNT = MATRIX_STEPS.length

// -----------------------------------------------------------------------------
// Model the five first-run Setup wizard steps.
// -----------------------------------------------------------------------------

/**
 * The Setup wizard's five ordered steps and short progress labels.
 * Share these labels so the wizard and shell derive the same step count.
 */
export const WIZARD_STEP_LABELS = [
  'Project',
  'Data',
  'Environment',
  'Pipeline',
  'Review',
] as const

/** The count of fixed Setup wizard steps. */
export const WIZARD_STEP_COUNT = WIZARD_STEP_LABELS.length

/** The final zero-based Setup wizard step. */
export const WIZARD_LAST_STEP = WIZARD_STEP_COUNT - 1

// -----------------------------------------------------------------------------
// Model the 14 configurable pipeline stages.
// -----------------------------------------------------------------------------

/**
 * The configurable pipeline-stage key order from `supraspina.project.json`.
 *
 * New stages are appended after `final` (`braincharts`, then `zstats`),
 * never inserted earlier, because a workflow node ID carries the node's
 * position in the plan. Mirror `STEP_DESCRIPTORS` in
 * `sidecar/supraspina_sidecar/registry.py`.
 */
export const STEP_KEYS = [
  'brainfov',
  'deface',
  'recon',
  'enigma',
  'outliers',
  'features',
  'age',
  'pybrainage',
  'clinical',
  'brainpad',
  'aggregate',
  'final',
  'braincharts',
  'zstats',
] as const

/** One configurable pipeline stage. */
export type StepKey = (typeof STEP_KEYS)[number]

/** Subject-level or cohort-level stage expansion. */
export type StepScope = 'subject' | 'cohort'

/** A map from every pipeline stage to its execution scope. */
export const STEP_SCOPES: Readonly<Record<StepKey, StepScope>> = {
  brainfov: 'subject',
  deface: 'subject',
  recon: 'subject',
  enigma: 'cohort',
  outliers: 'cohort',
  features: 'cohort',
  age: 'cohort',
  pybrainage: 'cohort',
  clinical: 'cohort',
  brainpad: 'cohort',
  aggregate: 'cohort',
  final: 'cohort',
  braincharts: 'cohort',
  zstats: 'cohort',
}

/** A classification of dynamic tool checks for proactive stage gating. */
export type CheckRequirement =
  | { kind: 'all'; ids: readonly string[] }
  | {
      kind: 'configured-choice'
      configPath:
        | 'steps.enigma.params.backend'
        | 'steps.deface.params.tool'
        | 'steps.recon.params.backend'
      choices: Readonly<Record<string, readonly string[]>>
    }
  | { kind: 'conditional'; when: string; ids: readonly string[] }

/** The supported ENIGMA execution backends. */
export const ENIGMA_BACKENDS = ['auto', 'matlab', 'mcr'] as const

/** A map from pipeline stages to their dynamic environment requirements. */
export const STEP_CHECK_REQUIREMENTS: Readonly<
  Partial<Record<StepKey, readonly CheckRequirement[]>>
> = {
  // Resolve managed SynthStrip readiness from the exact activated SIF in the
  // sidecar plan instead of the host-tool environment report.
  brainfov: [],
  recon: [
    {
      kind: 'configured-choice',
      configPath: 'steps.recon.params.backend',
      choices: {
        freesurfer: ['reconall', 'fshome', 'license'],
        fastsurfer: ['license'],
        auto: ['reconall', 'fshome', 'license'],
      },
    },
  ],
  deface: [
    {
      kind: 'configured-choice',
      configPath: 'steps.deface.params.tool',
      choices: {
        mri_deface: ['mri_deface', 'mri_deface_templates'],
        fsl_deface: ['fsl_deface'],
        pydeface: ['pydeface'],
        skip: [],
      },
    },
  ],
  // Mirror EnigmaAdapter.required_check_ids in
  // sidecar/supraspina_sidecar/adapters/enigma.py branch by branch: the wrapper
  // shell utilities, the ENIGMA assets, the selected backend, wslpath on a WSL
  // host, and xvfb-run without a display. The renderer reads the WSL branch
  // from the sidecar's own wslpath check, which the probe reports as skipped
  // off WSL, because the renderer has no other live host signal here.
  enigma: [
    {
      kind: 'all',
      ids: ['bash', 'awk', 'grep', 'cat', 'mkdir', 'enigma_assets'],
    },
    {
      kind: 'configured-choice',
      configPath: 'steps.enigma.params.backend',
      // `auto` resolves to the first installed backend in stage-blockers.
      choices: { auto: [], matlab: ['matlab'], mcr: ['mcr'] },
    },
    {
      kind: 'conditional',
      when: 'env.wslpath !== skipped',
      ids: ['wslpath'],
    },
    {
      kind: 'conditional',
      when: 'env.display !== found',
      ids: ['xvfb-run'],
    },
  ],
  outliers: [{ kind: 'all', ids: ['rscript', 'outliers_assets'] }],
  features: [
    { kind: 'all', ids: ['features_assets'] },
    {
      kind: 'configured-choice',
      configPath: 'steps.recon.params.backend',
      choices: {
        freesurfer: [
          'fshome',
          'license',
          'featurepython',
          'aparcstats',
          'asegstats',
        ],
        fastsurfer: ['license'],
        auto: ['fshome', 'license', 'featurepython', 'aparcstats', 'asegstats'],
      },
    },
  ],
  pybrainage: [
    {
      kind: 'all',
      ids: [
        'pyenv',
        'pybrainpython',
        'modelfile',
        'scalerfile',
        'pybrainage_assets',
      ],
    },
  ],
  age: [{ kind: 'all', ids: ['agepython'] }],
  clinical: [{ kind: 'all', ids: ['clinicalpython'] }],
  brainpad: [{ kind: 'all', ids: ['brainpadpython', 'brainpad_assets'] }],
  aggregate: [{ kind: 'all', ids: ['aggregatepython', 'aggregate_assets'] }],
  final: [
    { kind: 'all', ids: ['finalrscript', 'final_assets'] },
    // An absent renderReport takes its declared default (true), as the
    // sidecar reads it (FinalAdapter.required_check_ids and env/r.py
    // _render_report_enabled), so only an explicit false drops these checks.
    {
      kind: 'conditional',
      when: 'steps.final.params.renderReport !== false',
      ids: ['rmarkdown', 'knitr', 'pandoc', 'final_report_assets'],
    },
  ],
  braincharts: [{ kind: 'all', ids: ['bcenv', 'bcmodel'] }],
  // The z-score track runs on the R analysis interpreter (ZStatsAdapter).
  zstats: [
    { kind: 'all', ids: ['finalrscript', 'final_assets'] },
    {
      kind: 'conditional',
      when: 'steps.zstats.params.renderReport !== false',
      ids: ['rmarkdown', 'knitr', 'pandoc', 'final_report_assets'],
    },
  ],
}

/** A mirror of unconditional sidecar tool gates for proactive renderer checks. */
export const STEP_REQUIRED_CHECKS = Object.fromEntries(
  Object.entries(STEP_CHECK_REQUIREMENTS).flatMap(([key, requirements]) => {
    const ids = requirements
      .filter(
        (
          requirement,
        ): requirement is Extract<CheckRequirement, { kind: 'all' }> =>
          requirement.kind === 'all',
      )
      .flatMap((requirement) => requirement.ids)
    return ids.length > 0 ? [[key, ids]] : []
  }),
) as Partial<Record<StepKey, readonly string[]>>

/**
 * The explicit cross-step data dependencies. List in `STEP_DEPENDENCIES[B]`
 * the steps whose declared output artifacts step B reads as inputs. Treat an
 * edge `A -> B` as requiring A to produce its output before B runs for the
 * subjects in scope. Use B's input path template to verify that it references a
 * path produced by A. This map states the data DAG that each step's `inputs`
 * and `outputs` path templates imply.
 *
 * Compose this gate with the {@link STEP_CHECK_REQUIREMENTS} tool gate: allow a
 * step to run only when its tools and prerequisites are satisfied. Derive the
 * proactive renderer gate from this map in
 * `src/renderer/state/dependency-blockers.ts`, and keep it aligned with the
 * sidecar's authoritative submit-time preflight.
 *
 * Apply these conditional edges:
 * - Exclude user-supplied metadata files (the age, clinical, and final metadata inputs)
 *   because no step produces them.
 * - Apply `brainfov -> deface` when brain-FOV preparation and defacing are enabled;
 *   otherwise, apply `brainfov -> recon` directly.
 * - Resolve `deface -> recon` through {@link dependenciesForStep} only when
 *   defacing is enabled. Preserve Recon's raw-T1 input when defacing is disabled.
 *
 * Root the forest at `recon` when both preparation stages are disabled:
 * `enigma -> outliers`; `features -> age -> pybrainage -> clinical -> brainpad`;
 * `aggregate -> final`. Extend the applicable root branch when brain-FOV
 * preparation or defacing is enabled, as described above.
 */
export const STEP_DEPENDENCIES: Partial<Record<StepKey, readonly StepKey[]>> = {
  enigma: ['recon'],
  outliers: ['enigma'],
  features: ['recon'],
  age: ['features'],
  pybrainage: ['age'],
  clinical: ['pybrainage'],
  brainpad: ['clinical'],
  aggregate: ['recon'],
  final: ['aggregate'],
  braincharts: ['features'],
  zstats: ['braincharts'],
}

/** Resolve conditional preparation edges without mutating the canonical DAG. */
export function dependenciesForStep(
  key: StepKey,
  defaceEnabled: boolean,
  brainfovEnabled = false,
): readonly StepKey[] {
  if (key === 'deface' && brainfovEnabled) return ['brainfov']
  if (key === 'recon' && defaceEnabled) return ['deface']
  if (key === 'recon' && brainfovEnabled) return ['brainfov']
  return STEP_DEPENDENCIES[key] ?? []
}

interface ParamPresentation {
  /** Show this field only for the listed value(s) of a sibling parameter. */
  readonly visibleWhen?: {
    readonly name: string
    readonly values: readonly (string | number | boolean)[]
  }
}

/** One editable pipeline parameter and its presentation contract. */
export type ParamSpec = ParamPresentation &
  (
    | { kind: 'bool'; default: boolean; label: string }
    | { kind: 'int'; default: number; min: number; max: number; label: string }
    | {
        kind: 'float'
        default: number
        min?: number
        max?: number
        step?: number
        label: string
      }
    | { kind: 'text'; default: string; placeholder?: string; label: string }
    | {
        kind: 'path'
        default: string
        must: 'exist' | 'writable' | 'any'
        /**
         * The native picker for the Browse action: a directory picker by
         * default, or 'file' for parameters that name a file even when a
         * blank value is allowed (`must: 'any'`).
         */
        picker?: 'file' | 'dir'
        label: string
      }
    | {
        kind: 'choice'
        default: string
        options: readonly string[]
        label: string
      }
  )

/** One declared pipeline input or output artifact. */
export interface ArtifactRef {
  readonly label: string
  readonly pathTemplate: string
  /** The artifact class, for display in Results and QC. */
  readonly kind:
    | 'dir'
    | 'csv'
    | 'png'
    | 'html'
    | 'xlsx'
    | 'pdf'
    | 'txt'
    | 'nii'
    | 'glob'
}

/** One configurable pipeline stage and its durable defaults. */
export interface PipelineStep {
  /**
   * The canonical upstream pipeline ordinal, such as 2.5 for outlier review,
   * for the step descriptor and artifact provenance only; never shown to the
   * user as "Step N."
   */
  readonly id: number
  readonly key: StepKey
  /** The display name. */
  readonly name: string
  readonly goal: string
  readonly enabledByDefault: boolean
  readonly scope: StepScope
  /**
   * The matrix columns this stage advances. A manual or auxiliary stage that
   * owns no matrix column (defacing, statistical-QC outlier review, and the
   * manual age and clinical edits that a downstream column needs) maps to
   * that downstream column or `null`.
   */
  readonly advances: MatrixStepKey | readonly MatrixStepKey[] | null
  readonly inputs: readonly ArtifactRef[]
  readonly outputs: readonly ArtifactRef[]
  readonly params: Readonly<Record<string, ParamSpec>>
}

/**
 * The configurable pipeline stages.
 *
 * Treat parameter defaults as the durable contract. Expose only flags valid
 * and meaningful for the installed tool versions. Preserve these reconciliations
 * against the pinned provenance baseline in THIRD_PARTY_PROVENANCE.json:
 * - Keep `features.parcellation` at `aparc.a2009s` (Destrieux) by default.
 *   The pinned PyBrainAge feature order requires it. Aggregation and Final use
 *   the separate Desikan-Killiany `aparc` branch.
 * - Keep `enigma.backend` at `auto` by default: source MATLAB when it is
 *   installed, because it is verified on R2026a, else the free MATLAB Runtime
 *   plus compiled binaries. Either backend alone satisfies the step.
 * - Keep `enigma.fsVersion` at `7` by default. Account for FreeSurfer 7 and
 *   later using the `Left-Thalamus` label set and FreeSurfer 8 switching the QC
 *   input volume to `nu.mgz` through the wrapper's `--fs_version` branch.
 */
export const PIPELINE_STEPS: readonly PipelineStep[] = [
  {
    id: -1,
    key: 'brainfov',
    name: 'Brain FOV preparation',
    goal: 'Prepares high-FOV T1w inputs with a geometry-checked, mask-guided crop and explicit review.',
    enabledByDefault: true,
    scope: 'subject',
    advances: null,
    inputs: [
      {
        label: 'Authoritative raw T1w files',
        pathTemplate: '${paths.rawdataDir}',
        kind: 'nii',
      },
    ],
    outputs: [
      {
        label: 'Brain FOV derivatives',
        pathTemplate: '${paths.derivativesDir}/supraspina-brainfov',
        kind: 'dir',
      },
      {
        label: 'Brain FOV QC montage',
        pathTemplate:
          '${paths.derivativesDir}/supraspina-brainfov/${subject}/**/*_desc-brainfov*_qc.png',
        kind: 'png',
      },
      {
        label: 'Brain FOV provenance',
        pathTemplate:
          '${paths.derivativesDir}/supraspina-brainfov/${subject}/**/*_desc-brainfov*_T1w.json',
        kind: 'txt',
      },
    ],
    params: {
      marginMm: {
        kind: 'int',
        default: 30,
        min: 15,
        max: 60,
        label: 'Brain margin per crop face (mm)',
      },
    },
  },
  {
    id: 0,
    key: 'deface',
    name: 'Optional defacing',
    goal: 'Optionally runs the selected defacing tool before structural processing.',
    enabledByDefault: false,
    scope: 'subject',
    advances: null,
    inputs: [
      {
        label: 'Input T1w files',
        pathTemplate: '${paths.rawdataDir}',
        kind: 'nii',
      },
    ],
    outputs: [
      {
        label: 'Defaced T1w',
        pathTemplate:
          '${paths.derivativesDir}/defaced/${subject}/anat/${subject}_T1w.nii.gz',
        kind: 'nii',
      },
    ],
    params: {
      // Preserve the upstream-compatible mri_deface default. Project validation
      // blocks execution when the selected external tool is unavailable.
      tool: {
        kind: 'choice',
        default: 'mri_deface',
        options: ['mri_deface', 'fsl_deface', 'pydeface', 'skip'],
        label: 'Defacing tool',
      },
      forceOverwrite: {
        kind: 'bool',
        default: false,
        label: 'Overwrite existing defaced volumes',
      },
    },
  },
  {
    id: 1,
    key: 'recon',
    name: 'Reconstruction',
    goal: 'Runs cortical reconstruction and compatible parcellation for every subject.',
    enabledByDefault: true,
    scope: 'subject',
    advances: 'recon',
    inputs: [
      {
        label: 'Input data folder',
        pathTemplate: '${paths.rawdataDir}',
        kind: 'dir',
      },
      {
        label: 'Subject folder pattern',
        pathTemplate: '${patterns.subjectGlob}',
        kind: 'glob',
      },
      {
        label: 'T1 file pattern',
        pathTemplate: '${patterns.t1Pattern}',
        kind: 'glob',
      },
    ],
    outputs: [
      {
        label: 'Default FreeSurfer subject directory',
        pathTemplate: '${paths.derivativesDir}/freesurfer/${subject}',
        kind: 'dir',
      },
      {
        label: 'Default FreeSurfer completion marker',
        pathTemplate:
          '${paths.derivativesDir}/freesurfer/${subject}/scripts/recon-all.done',
        kind: 'txt',
      },
    ],
    params: {
      backend: {
        kind: 'choice',
        default: 'freesurfer',
        options: ['freesurfer', 'fastsurfer', 'auto'],
        label: 'Reconstruction backend',
      },
      fastsurferDevice: {
        kind: 'choice',
        default: 'auto',
        options: ['auto', 'cpu', 'cuda'],
        label: 'FastSurfer device',
        visibleWhen: {
          name: 'backend',
          values: ['fastsurfer', 'auto'],
        },
      },
      directives: {
        kind: 'text',
        default: '-all',
        label: 'recon-all directives',
        visibleWhen: { name: 'backend', values: ['freesurfer', 'auto'] },
      },
      parallel: {
        kind: 'bool',
        default: true,
        label: 'Parallel hemispheres',
        visibleWhen: { name: 'backend', values: ['freesurfer', 'auto'] },
      },
    },
  },
  {
    id: 2,
    key: 'enigma',
    name: 'ENIGMA QC',
    goal: 'Runs ENIGMA FreeSurfer QA to create cortical and subcortical measures, QC PNG montages, and static HTML galleries.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: ['qcsub', 'qcic', 'qcec'],
    inputs: [
      {
        label: 'FreeSurfer derivatives',
        pathTemplate: '${paths.derivativesDir}/freesurfer',
        kind: 'dir',
      },
    ],
    outputs: [
      {
        label: 'Subcortical measures',
        pathTemplate: '${paths.qcOutputDir}/measures/LandRvolumes.csv',
        kind: 'csv',
      },
      {
        label: 'Cortical thickness measures',
        pathTemplate:
          '${paths.qcOutputDir}/measures/CorticalMeasuresENIGMA_ThickAvg.csv',
        kind: 'csv',
      },
      {
        label: 'Cortical surface-area measures',
        pathTemplate:
          '${paths.qcOutputDir}/measures/CorticalMeasuresENIGMA_SurfAvg.csv',
        kind: 'csv',
      },
      {
        label: 'Subcortical QC gallery',
        pathTemplate:
          '${paths.qcOutputDir}/qc/subcortical/ENIGMA_Subcortical_QC.html',
        kind: 'html',
      },
      {
        label: 'Cortical-internal QC gallery',
        pathTemplate:
          '${paths.qcOutputDir}/qc/cortical_internal/ENIGMA_Cortical_QC.html',
        kind: 'html',
      },
      {
        label: 'Cortical-external QC gallery',
        pathTemplate:
          '${paths.qcOutputDir}/qc/cortical_external/ENIGMA_External_QC.html',
        kind: 'html',
      },
    ],
    params: {
      backend: {
        kind: 'choice',
        default: 'auto',
        options: ENIGMA_BACKENDS,
        label: 'Configured QC backend',
      },
      matlabExecutable: {
        kind: 'path',
        default: '',
        must: 'any',
        picker: 'file',
        label: 'MATLAB executable (matlab backend)',
      },
      mcrRoot: {
        kind: 'path',
        default: '',
        must: 'any',
        label: 'MATLAB Runtime root (mcr backend, R2019b/v9.7)',
      },
      enigmaScriptDir: {
        kind: 'path',
        default: '',
        must: 'any',
        label: 'ENIGMA script directory (blank = active reviewed assets)',
      },
      outDir: {
        kind: 'path',
        default: '${paths.qcOutputDir}',
        must: 'writable',
        label: 'QC output directory',
      },
      fsVersion: {
        kind: 'choice',
        default: '7',
        options: ['5', '6', '7', '8'],
        label: 'FreeSurfer version (--fs_version)',
      },
    },
  },
  {
    id: 2.5,
    key: 'outliers',
    name: 'Histogram and outlier review',
    goal: 'Plots per-region histograms and flags values beyond mean +/- z SD for review.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: null,
    inputs: [
      {
        label: 'ENIGMA measures',
        pathTemplate: '${paths.qcOutputDir}/measures',
        kind: 'dir',
      },
    ],
    outputs: [
      {
        label: 'Outliers',
        pathTemplate: '${paths.qcOutputDir}/qa_outliers/outliers.csv',
        kind: 'csv',
      },
      {
        label: 'Histograms',
        pathTemplate: '${paths.qcOutputDir}/qa_outliers/hist',
        kind: 'glob',
      },
    ],
    params: {
      zThreshold: {
        kind: 'float',
        default: 2.698,
        min: 0,
        label: 'Outlier z threshold (default 2.698)',
      },
    },
  },
  {
    id: 3,
    key: 'features',
    name: 'FreeSurfer feature extraction',
    goal: 'Builds the PyBrainAge feature matrix from Destrieux cortical thickness and subcortical volumes.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: 'feat',
    inputs: [
      {
        label: 'FreeSurfer derivatives',
        pathTemplate: '${paths.derivativesDir}/freesurfer',
        kind: 'dir',
      },
    ],
    outputs: [
      {
        label: 'Concatenated features',
        pathTemplate: '${paths.outputDir}/features/concatenated_results.csv',
        kind: 'csv',
      },
    ],
    params: {
      parcellation: {
        kind: 'choice',
        default: 'aparc.a2009s',
        options: ['aparc.a2009s', 'aparc.DKTatlas', 'aparc'],
        label:
          'Atlas (a2009s required by the PyBrainAge model; changing is flagged)',
      },
      measure: {
        kind: 'choice',
        default: 'thickness',
        options: ['thickness', 'area', 'volume'],
        label: 'aparcstats2table measure',
      },
      outDir: {
        kind: 'path',
        default: '${paths.outputDir}/features',
        must: 'writable',
        label: 'Feature output directory',
      },
      validateFeatureOrder: {
        kind: 'bool',
        default: true,
        label: 'Validate 188-column feature order (ID + 187 features)',
      },
    },
  },
  {
    id: 4,
    key: 'age',
    name: 'Age metadata integration',
    goal: 'Inserts chronological age as column 2 to produce the model-ready 189-column table.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: 'feat',
    inputs: [
      {
        label: 'Concatenated features',
        pathTemplate: '${paths.outputDir}/features/concatenated_results.csv',
        kind: 'csv',
      },
      {
        label: 'Age metadata',
        pathTemplate: '${paths.ageMetadataFile}',
        kind: 'csv',
      },
    ],
    outputs: [
      {
        label: 'Features with age',
        pathTemplate: '${paths.outputDir}/features/subject_features.csv',
        kind: 'csv',
      },
    ],
    params: {
      subjectIdColumn: {
        kind: 'text',
        default: 'participant_id',
        label: 'Subject ID column',
      },
      ageColumn: { kind: 'text', default: 'age', label: 'Age column' },
      join: {
        kind: 'choice',
        default: 'left',
        options: ['inner', 'left', 'outer'],
        label: 'Join strategy (left keeps unmatched subjects as NaN age)',
      },
      warnOnMissing: {
        kind: 'bool',
        default: true,
        label: 'Warn on missing age',
      },
    },
  },
  {
    id: 5,
    key: 'pybrainage',
    name: 'PyBrainAge prediction',
    goal: 'Predicts BrainAge + Brain-PAD (BrainAge - Age) for every subject using the pinned ExtraTrees model.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: 'pba',
    inputs: [
      {
        label: 'Features with age',
        pathTemplate: '${paths.outputDir}/features/subject_features.csv',
        kind: 'csv',
      },
      {
        label: 'Managed model',
        pathTemplate:
          '${paths.outputDir}/.pybrainage/current/pybrainage/v3/software/ExtraTreesModel',
        kind: 'txt',
      },
      {
        label: 'Managed scaler',
        pathTemplate:
          '${paths.outputDir}/.pybrainage/current/pybrainage/v3/software/scaler.pkl',
        kind: 'txt',
      },
    ],
    outputs: [
      {
        label: 'Predictions',
        pathTemplate: '${paths.outputDir}/pybrainage/predicted_results.csv',
        kind: 'csv',
      },
    ],
    params: {
      pythonExecutable: {
        kind: 'path',
        default: '',
        must: 'any',
        label: 'PyBrainAge env python (provisioned)',
      },
      modelPath: {
        kind: 'path',
        default: '${pybrain.modelPath}',
        must: 'exist',
        label: 'ExtraTreesModel path',
      },
      scalerPath: {
        kind: 'path',
        default: '${pybrain.scalerPath}',
        must: 'exist',
        label: 'scaler.pkl path',
      },
      rowFallback: {
        kind: 'bool',
        default: true,
        label: 'Row-by-row predict fallback',
      },
    },
  },
  {
    id: 6,
    key: 'clinical',
    name: 'Clinical merge',
    goal: 'Merges BrainAge predictions with clinical metadata into the analysis workbook.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: 'stats',
    inputs: [
      {
        label: 'Predictions',
        pathTemplate: '${paths.outputDir}/pybrainage/predicted_results.csv',
        kind: 'csv',
      },
      {
        label: 'Clinical metadata',
        pathTemplate: '${paths.clinicalMetadataFile}',
        kind: 'csv',
      },
    ],
    outputs: [
      {
        label: 'Analysis workbook',
        pathTemplate: '${paths.outputDir}/analysis/predicted_results.xlsx',
        kind: 'xlsx',
      },
    ],
    params: {
      joinKey: { kind: 'text', default: 'participant_id', label: 'Join key' },
      requiredColumns: {
        kind: 'text',
        default: 'Cohort,AIS',
        label: 'Required clinical columns',
      },
    },
  },
  {
    id: 7,
    key: 'brainpad',
    name: 'Brain-PAD statistics',
    goal: 'Compares group-level Brain-PAD by cohort, sex, and AIS, then computes effect sizes and figures.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: 'stats',
    inputs: [
      {
        label: 'Analysis workbook',
        pathTemplate: '${paths.outputDir}/analysis/predicted_results.xlsx',
        kind: 'xlsx',
      },
    ],
    // Declare the seven CSV tables and five figures individually to match
    // the basenames that brainpadstats.py binds to output_path1..12 so Results
    // can surface each one. Preserve the source misspelling in the AIS table
    // name.
    outputs: [
      {
        label: 'Summary statistics',
        pathTemplate: '${paths.outputDir}/analysis/summary_statistics.csv',
        kind: 'csv',
      },
      {
        label: 'Brain-PAD across cohorts',
        pathTemplate: '${paths.outputDir}/analysis/BrainPAD_across_cohorts.csv',
        kind: 'csv',
      },
      {
        label: 'Brain-PAD across sex',
        pathTemplate: '${paths.outputDir}/analysis/BrainPAD_across_sex.csv',
        kind: 'csv',
      },
      {
        label: 'Brain-PAD across AIS',
        pathTemplate: '${paths.outputDir}/analysis/BrainPAD_acorss_AIS.csv',
        kind: 'csv',
      },
      {
        label: 'Chi-square across AIS',
        pathTemplate: '${paths.outputDir}/analysis/Chi2_AIS.csv',
        kind: 'csv',
      },
      {
        label: 'Time-since-injury comparison',
        pathTemplate:
          '${paths.outputDir}/analysis/TimeSinceInjury_Comparison.csv',
        kind: 'csv',
      },
      {
        label: 'Chronological-age comparison',
        pathTemplate:
          '${paths.outputDir}/analysis/ChronologicalAge_Comparison.csv',
        kind: 'csv',
      },
      {
        label: 'Brain-PAD comparison figure',
        pathTemplate: '${paths.outputDir}/analysis/BrainPAD_comparison.png',
        kind: 'png',
      },
      {
        label: 'Chronological age vs predicted brain age figure',
        pathTemplate:
          '${paths.outputDir}/analysis/Chronological_vs_BrainAge.png',
        kind: 'png',
      },
      {
        label: 'Brain-PAD vs chronological age figure',
        pathTemplate: '${paths.outputDir}/analysis/BrainPAD_vs_Age.png',
        kind: 'png',
      },
      {
        label: 'Brain-PAD across sex figure',
        pathTemplate: '${paths.outputDir}/analysis/BrainPAD_across_sex.png',
        kind: 'png',
      },
      {
        label: 'Brain-PAD vs time-since-injury figure',
        pathTemplate:
          '${paths.outputDir}/analysis/BrainPAD_vs_TimeSinceInjury.png',
        kind: 'png',
      },
    ],
    params: {
      outDir: {
        kind: 'path',
        default: '${paths.outputDir}/analysis',
        must: 'writable',
        label: 'Analysis output directory',
      },
    },
  },
  {
    id: 8,
    key: 'aggregate',
    name: 'Structural data aggregation',
    goal: 'Aggregates DK stats, cortical thickness, ICV, and white-matter volumes across the cohort.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: 'agg',
    inputs: [
      {
        label: 'FreeSurfer derivatives',
        pathTemplate: '${paths.derivativesDir}/freesurfer',
        kind: 'dir',
      },
    ],
    outputs: [
      {
        label: 'DK stats',
        pathTemplate: '${paths.outputDir}/structural/dk_all_stats.csv',
        kind: 'csv',
      },
      {
        label: 'Cortical thickness',
        pathTemplate: '${paths.outputDir}/structural/cortical_thickness.csv',
        kind: 'csv',
      },
      {
        label: 'ICV',
        pathTemplate: '${paths.outputDir}/structural/icv_data.csv',
        kind: 'csv',
      },
      {
        label: 'WM volumes',
        pathTemplate: '${paths.outputDir}/structural/wm_volumes.csv',
        kind: 'csv',
      },
    ],
    params: {
      subjectGlob: {
        kind: 'text',
        default: 'sub-*',
        label: 'Subject folder pattern',
      },
      outDir: {
        kind: 'path',
        default: '${paths.outputDir}/structural',
        must: 'writable',
        label: 'Structural output directory',
      },
    },
  },
  {
    id: 9,
    key: 'final',
    name: 'R analysis',
    goal: 'Runs the final R structural analysis to create effect-size tables and an optional HTML report.',
    enabledByDefault: true,
    scope: 'cohort',
    advances: 'rep',
    inputs: [
      {
        label: 'Structural CSVs',
        pathTemplate: '${paths.outputDir}/structural',
        kind: 'dir',
      },
      {
        label: 'Metadata',
        pathTemplate: '${paths.metadataDir}/metadata.csv',
        kind: 'csv',
      },
    ],
    outputs: [
      {
        label: 'SCI result tables (XLSX or CSV)',
        pathTemplate: '${paths.outputDir}/final/SCI_*_results.*',
        kind: 'glob',
      },
      {
        label: 'SUB result tables (XLSX or CSV)',
        pathTemplate: '${paths.outputDir}/final/SUB_*_results.*',
        kind: 'glob',
      },
      {
        label: 'WM result tables (XLSX or CSV)',
        pathTemplate: '${paths.outputDir}/final/WM_*_results.*',
        kind: 'glob',
      },
      {
        label: 'Site exclusions',
        pathTemplate: '${paths.outputDir}/final/site_exclusions.csv',
        kind: 'csv',
      },
      {
        label: 'ICV summary',
        pathTemplate: '${paths.outputDir}/final/summary_icv.csv',
        kind: 'csv',
      },
      {
        label: 'Thickness summary',
        pathTemplate: '${paths.outputDir}/final/summary_thickness.csv',
        kind: 'csv',
      },
      {
        label: 'Report',
        pathTemplate: '${paths.outputDir}/final/report.html',
        kind: 'html',
      },
    ],
    params: {
      rscriptExecutable: {
        kind: 'path',
        default: '${tools.rscriptExecutable}',
        must: 'any',
        label: 'Rscript executable',
      },
      outDir: {
        kind: 'path',
        default: '${paths.outputDir}/final',
        must: 'writable',
        label: 'R analysis output directory',
      },
      renderReport: {
        kind: 'bool',
        default: true,
        label: 'Render HTML report',
      },
    },
  },
  {
    // Listed beside PyBrainAge by its id; appended here so no node moves.
    id: 5.5,
    key: 'braincharts',
    name: 'BrainCharts normative modeling',
    goal: 'Adapts the lifespan BrainCharts model to the controls of each site and writes per-region z-scores.',
    enabledByDefault: false,
    scope: 'cohort',
    advances: 'norm',
    inputs: [
      {
        label: 'Concatenated features',
        pathTemplate: '${paths.outputDir}/features/concatenated_results.csv',
        kind: 'csv',
      },
      {
        label: 'Managed BrainCharts model',
        pathTemplate:
          '${paths.outputDir}/.braincharts/current/models/lifespan_57K_82sites',
        kind: 'dir',
      },
    ],
    outputs: [
      {
        label: 'BrainCharts z-scores',
        pathTemplate: '${paths.outputDir}/braincharts/braincharts_zscores.csv',
        kind: 'csv',
      },
      {
        label: 'BrainCharts test table with z-scores',
        pathTemplate:
          '${paths.outputDir}/braincharts/braincharts_test_with_zscores.csv',
        kind: 'csv',
      },
      {
        label: 'BrainCharts z-score summary',
        pathTemplate:
          '${paths.outputDir}/braincharts/braincharts_zscore_summary.csv',
        kind: 'csv',
      },
      {
        label: 'BrainCharts split report',
        pathTemplate:
          '${paths.outputDir}/braincharts/braincharts_split_report.csv',
        kind: 'csv',
      },
      {
        label: 'BrainCharts subject roles',
        pathTemplate: '${paths.outputDir}/braincharts/braincharts_split.csv',
        kind: 'csv',
      },
      {
        label: 'BrainCharts refused sites',
        pathTemplate:
          '${paths.outputDir}/braincharts/braincharts_refused_sites.csv',
        kind: 'csv',
      },
      {
        label: 'BrainCharts run record',
        pathTemplate: '${paths.outputDir}/braincharts/braincharts_run.json',
        kind: 'txt',
      },
    ],
    params: {
      seed: {
        kind: 'int',
        default: 117,
        min: 0,
        max: 2147483647,
        label: 'Adaptation split seed (upstream 117)',
      },
    },
  },
  {
    // Listed beside R analysis by its id; appended here so no node moves.
    id: 9.5,
    key: 'zstats',
    name: 'Z-score group comparisons',
    goal: 'Compares BrainCharts z-scores between cohorts with per-region Welch t-tests and Hedges g, pooling the adapted sites.',
    enabledByDefault: false,
    scope: 'cohort',
    advances: null,
    inputs: [
      {
        label: 'BrainCharts z-scores',
        pathTemplate: '${paths.outputDir}/braincharts/braincharts_zscores.csv',
        kind: 'csv',
      },
      {
        label: 'BrainCharts refused sites',
        pathTemplate:
          '${paths.outputDir}/braincharts/braincharts_refused_sites.csv',
        kind: 'csv',
      },
    ],
    outputs: [
      {
        label: 'Z_SCI result tables (XLSX or CSV)',
        pathTemplate: '${paths.outputDir}/zstats/Z_SCI_*_results.*',
        kind: 'glob',
      },
      {
        label: 'Z_SUB result tables (XLSX or CSV)',
        pathTemplate: '${paths.outputDir}/zstats/Z_SUB_*_results.*',
        kind: 'glob',
      },
      {
        label: 'Report',
        pathTemplate: '${paths.outputDir}/zstats/report.html',
        kind: 'html',
      },
    ],
    params: {
      renderReport: {
        kind: 'bool',
        default: true,
        label: 'Render HTML report',
      },
    },
  },
] as const

/**
 * The pipeline stages in display order, by upstream ordinal `id`: the stages
 * appended after R analysis list beside the stages they extend, BrainCharts
 * after PyBrainAge and the z-score comparisons after R analysis. Plan and node
 * order stay {@link PIPELINE_STEPS}.
 */
export const PIPELINE_STEPS_IN_DISPLAY_ORDER: readonly PipelineStep[] = [
  ...PIPELINE_STEPS,
].sort((a, b) => a.id - b.id)

/**
 * Look up a pipeline step by its config key.
 *
 * @throws When `key` is not a known StepKey.
 */
export function pipelineStep(key: StepKey): PipelineStep {
  const step = PIPELINE_STEPS.find((s) => s.key === key)
  if (!step) {
    throw new Error(`Provide a known pipeline step key: ${key}.`)
  }
  return step
}

/**
 * Return the matrix columns that a step advances as an array.
 *
 * @returns The advanced matrix columns, or an empty array for the auxiliary
 *   steps (`deface`, `outliers`) that advance none. Use it to read a
 *   prerequisite step's completion from `Subject.cells`.
 * @throws When `key` is not a known StepKey (via {@link pipelineStep}).
 */
export function advancedColumns(key: StepKey): readonly MatrixStepKey[] {
  const adv = pipelineStep(key).advances
  if (adv === null) return []
  if (typeof adv === 'string') return [adv]
  return adv
}

/**
 * Return default parameter values for a pipeline step, keyed by parameter name.
 *
 * @throws When `key` is not a known StepKey (via {@link pipelineStep}).
 */
export function defaultParams(
  key: StepKey,
): Record<string, ParamSpec['default']> {
  const out: Record<string, ParamSpec['default']> = {}
  for (const [name, spec] of Object.entries(pipelineStep(key).params)) {
    out[name] = spec.default
  }
  return out
}
