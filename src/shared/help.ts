/**
 * Plain-language help content for the Supraspina console.
 *
 * This module is the single source of truth for explanatory UI copy. Keep it
 * separate from the structural model so every screen can share explanations
 * without changing the readonly step contract or its sidecar mirror.
 *
 * The content mirrors {@link MatrixStepKey}, {@link StepKey}, and parameter keys
 * formatted as `"<stepKey>.<paramName>"`; `help.test.ts` prevents coverage
 * drift.
 *
 * Write one or two short, jargon-free sentences in operator language. Explain
 * every necessary technical term. Describe only established behavior, needs,
 * and outputs.
 */

import { pipelineStep, type MatrixStepKey, type StepKey } from './steps'
import type { Cohort, EnvCheck } from './types'

/** Guidance on how to populate an empty analysis cohort before running. */
export const EMPTY_COHORT_RUN_REASON =
  'Set the data folder in the Setup wizard, then refresh subject discovery.'

/** Guidance on each subject-matrix column in operator language. */
export const MATRIX_STEP_HELP: Record<MatrixStepKey, string> = {
  recon:
    'Runs the receipt-selected FreeSurfer or FastSurfer backend to produce the surfaces and regional outputs that later stages require.',
  qcsub:
    'The ENIGMA subcortical montage, reviewed for the segmentation of deep structures such as the thalamus and hippocampus.',
  qcic: 'The ENIGMA internal cortical cross-sections, reviewed for surface-reconstruction errors inside the brain.',
  qcec: 'The ENIGMA external cortical surfaces, reviewed for apparent labeling or shape problems.',
  feat: 'Gathers the cortical-thickness and subcortical-volume values that the brain-age model requires.',
  pba: "Predicts each subject's brain age and Brain-PAD with PyBrainAge.",
  norm: "Writes a z-score for each region from the BrainCharts lifespan model adapted to each site's controls. The stage is off by default, and a site with fewer than 2 controls gets no z-scores.",
  stats:
    'Merges brain-age and clinical metadata, then generates the fixed cohort, sex, AIS, and time-since-injury analyses.',
  agg: 'Collects per-subject thickness, volume, and intracranial-volume measures into cohort-wide tables.',
  rep: 'The R analysis tables and optional HTML report for the fixed structural comparisons.',
}

/** Guidance on each configurable pipeline stage in operator language. */
export const STEP_HELP: Record<StepKey, string> = {
  brainfov:
    'Checks the physical field of view of each raw T1 and crops images over 256 mm around a SynthStrip brain mask without resampling. Every crop needs approval in Input QC before reconstruction.',
  deface:
    'Optionally runs the selected defacing tool before reconstruction. The output check does not establish de-identification, privacy compliance, or permission to share an image.',
  recon:
    'Runs a full FreeSurfer or FastSurfer reconstruction for every subject and records the selected backend in each reconstruction receipt.',
  enigma:
    "Runs the ENIGMA consortium's standard FreeSurfer quality control: it computes cortical and subcortical measures and renders the montages and HTML galleries for review.",
  outliers:
    'Builds per-region histograms and flags values beyond the configured z threshold for review. An outlier flag does not diagnose a segmentation problem or exclude a subject.',
  features:
    'Builds the model-ready feature table from Destrieux cortical thickness and subcortical volumes in the trained column order.',
  age: "Adds each subject's chronological age as the second feature-table column, producing the expected 189-column model input.",
  pybrainage:
    'Runs the pinned PyBrainAge model and computes Brain-PAD for every subject. It needs the provisioned model and scaler.',
  clinical:
    'Joins brain-age predictions with cohort, injury-severity, and time-since-injury data in one analysis workbook.',
  brainpad:
    'Generates the fixed Brain-PAD cohort, sex, AIS, time-since-injury, and age comparisons plus their effect sizes and figures.',
  aggregate:
    'Collects Desikan statistics, cortical thickness, intracranial volume, and white-matter volumes into cohort-wide tables.',
  final:
    'Runs the R analysis to create per-comparison effect-size result tables and, when enabled, a summary HTML report. It needs Rscript; writexl adds workbook output, showtext and sysfonts add font enhancements, and report rendering needs rmarkdown, knitr, and Pandoc.',
  braincharts:
    "Adapts the BrainCharts lifespan model to each site's controls and writes a z-score for every region of each held-out control and SCI subject. A site with fewer than 2 controls gets no z-scores. It needs the BrainCharts model and runtime from Scientific resources.",
  zstats:
    "Runs the final R comparisons on the BrainCharts z-scores: per-region Welch t-tests and Hedges g for the four contrasts over the thickness and subcortical z-score blocks, and, when enabled, an HTML report. Effects are control minus SCI, as in the final R tables. Sites are pooled because each site's offset is adapted away; sites BrainCharts refused have no rows. It needs BrainCharts z-scores and the final R tools.",
}

/**
 * The stage names with an abbreviation, spelled out for their tooltips.
 * Removing the parenthesis gives the stage name.
 */
export const STEP_NAME_SPELLED_OUT: Partial<Record<StepKey, string>> = {
  brainfov: 'Brain FOV (field of view) preparation',
  brainpad: 'Brain-PAD (brain predicted age difference) statistics',
}

/**
 * Return a stage name for a tooltip, with its abbreviations spelled out.
 *
 * @param key - The stage.
 * @returns The spelled-out name, or the stage name when it has none.
 */
export function spelledOutStepName(key: StepKey): string {
  return STEP_NAME_SPELLED_OUT[key] ?? pipelineStep(key).name
}

/**
 * Guidance on every editable parameter keyed as `"<stepKey>.<param>"`. Describe the
 * practical effect of changing each value.
 */
export const PARAM_HELP: Record<string, string> = {
  'brainfov.marginMm':
    'The physical clearance between the brain mask and each crop face. A capped crop is rejected when any face would retain less than 15 mm.',
  'deface.tool':
    'The program that blanks out the face: mri_deface from FreeSurfer, an alternative, or "skip", which copies the scan unchanged.',
  'deface.forceOverwrite':
    'When on, subjects that already have a defaced volume are defaced again instead of keeping it.',
  'recon.backend':
    'The full reconstruction implementation. "auto" starts with FreeSurfer and authorizes a cohort-wide FastSurfer fallback only for classified surface-algorithm failures.',
  'recon.fastsurferDevice':
    'The FastSurfer compute device. "auto" selects verified CUDA or falls back to CPU with a slow-run advisory.',
  'recon.directives':
    'The recon-all run preset; specific FreeSurfer stage flags replace "-all" only when a run requires them.',
  'recon.parallel':
    'When on, recon-all -parallel reconstructs both hemispheres concurrently, so each subject finishes faster on one extra core.',
  'enigma.backend':
    'How the QC step runs MATLAB code. "auto" runs a licensed MATLAB installation when one is found and the free R2019b MATLAB Runtime otherwise, and "matlab" or "mcr" pins one engine. The detector disables unavailable engines.',
  'enigma.matlabExecutable':
    'The path to the "matlab" program for the matlab backend. When it is blank, Supraspina detects the program on the system PATH.',
  'enigma.mcrRoot':
    'The MATLAB Runtime (R2019b / v9.7) folder for the mcr backend. When it is blank, Supraspina detects a runtime installed under /usr/local/MATLAB, /opt/MATLAB/MATLAB_Runtime, or /opt/mcr.',
  'enigma.enigmaScriptDir':
    'A specific ENIGMA QC script directory. When it is blank, the stage uses the active reviewed assets acquired through the pinned first-use flow.',
  'enigma.outDir':
    'Where QC measures, montage images, and HTML galleries are written.',
  'enigma.fsVersion':
    'The FreeSurfer version that produced the reconstruction outputs. It selects the thalamus label set (5/6 versus 7+), and on version 8 the stage reads nu.mgz instead of orig_nu.mgz.',
  'outliers.zThreshold':
    'The number of standard deviations used by the current outlier implementation; a lower value flags more values for review.',
  'features.parcellation':
    'The cortical atlas to read. The pinned model requires the Destrieux features of aparc.a2009s; the separate aggregation branch reads Desikan-Killiany aparc statistics.',
  'features.measure':
    'The per-region FreeSurfer measure: cortical thickness, surface area, or volume. The trained model uses cortical thickness.',
  'features.outDir': 'Where the extracted feature table is written.',
  'features.validateFeatureOrder':
    'When on, the stage checks that feature extraction produces ID plus 187 ordered features (188 columns); Age integration adds the 189th model-table column.',
  'age.subjectIdColumn': 'The age-spreadsheet column that identifies subjects.',
  'age.ageColumn':
    "The age-spreadsheet column that contains each subject's age.",
  'age.join':
    'How subjects combine with the age table: "left" keeps every subject, "inner" drops missing ages, and "outer" keeps every row.',
  'age.warnOnMissing':
    'When on, a subject with no matching age raises a warning instead of passing silently.',
  'pybrainage.pythonExecutable':
    'Python from the provisioned PyBrainAge environment. When it is blank, Supraspina resolves it automatically.',
  'pybrainage.modelPath':
    'The trained ExtraTrees brain-age model path. Normal use keeps the provisioned default.',
  'pybrainage.scalerPath':
    'The feature-scaler path that matches the model. Normal use keeps the provisioned default.',
  'pybrainage.rowFallback':
    'When on, a failed batch prediction falls back to predicting one row at a time, so one bad row does not stop the rest.',
  'clinical.joinKey':
    'The column that matches brain-age predictions to the clinical spreadsheet.',
  'clinical.requiredColumns':
    'The required clinical columns, separated by commas. Cohort and AIS are required by default, and time since SCI only when an analysis needs it.',
  'brainpad.outDir': 'Where statistics tables and figures are written.',
  'aggregate.subjectGlob':
    'The folder-name pattern that matches subjects for aggregation.',
  'aggregate.outDir':
    'Where the combined cohort-wide structural tables are written.',
  'final.rscriptExecutable':
    'The Rscript path that runs the R analysis. The default uses the detected R.',
  'final.outDir':
    'Where result tables and the optional HTML report are written.',
  'final.renderReport':
    "When on, the stage also renders the HTML report, which needs R's rmarkdown and knitr packages plus Pandoc; when off, it produces only result tables.",
  'zstats.renderReport':
    "When on, the stage also renders the HTML report, which needs R's rmarkdown and knitr packages plus Pandoc; when off, it produces only the z-score tables.",
  'braincharts.seed':
    "The seed of the random split of each site's controls into adaptation and held-out halves. The run records it; upstream uses 117.",
}

/** Guidance on established scientific and operational terms. */
export const GLOSSARY: Record<string, string> = {
  'recon-all':
    "recon-all is FreeSurfer's end-to-end command for reconstructing cortical surfaces and labeling brain regions from a T1 scan.",
  FreeSurfer:
    "FreeSurfer is the pipeline's core toolkit for reconstructing and labeling each brain from MRI.",
  Desikan:
    'Desikan is the standard atlas with about 34 cortical regions per hemisphere.',
  Destrieux:
    'Destrieux is the finer cortical atlas used to build brain-age features.',
  'aparc.a2009s':
    "aparc.a2009s is FreeSurfer's name for the Destrieux cortical atlas.",
  ENIGMA:
    'ENIGMA is the consortium whose standardized FreeSurfer QC protocol runs here.',
  IQI: 'IQI means image quality indicator. No current project setting or scientific stage applies an IQI threshold.',
  'Brain-PAD':
    "Brain Predicted Age Difference is the model's predicted age minus the provided chronological age. A positive value means only that this model estimate is higher than the provided age.",
  BrainAge: 'BrainAge is the age predicted from structural brain measures.',
  PyBrainAge:
    'PyBrainAge is the pinned scikit-learn ExtraTrees brain-age model.',
  ICV: 'ICV is the intracranial-volume value read from FreeSurfer output.',
  'DK stats':
    'DK stats are per-region statistics from the Desikan-Killiany atlas.',
  MCR: 'MATLAB Runtime runs compiled MATLAB code without a paid MATLAB license.',
  AIS: 'AIS means ASIA Impairment Scale. It is operator-provided clinical metadata; Supraspina does not assign or validate the grade.',
}

/** Guidance on accepted cohort labels and their analysis meaning. */
export const COHORT_HELP: Record<string, string> = {
  control: 'The exact control-cohort code the Brain-PAD analysis recognizes.',
  CTRL: 'The application registry code for the control cohort.',
  SCI_nNP: 'Spinal cord injury without pain.',
  SCI_P: 'Spinal cord injury with pain.',
}

/**
 * Short cohort labels for display. Preserve internal cohort codes in
 * data, form values, and React keys.
 */
export const COHORT_LABEL: Record<Cohort, string> = {
  CTRL: 'Control',
  SCI_nNP: 'SCI, no pain',
  SCI_P: 'SCI, pain',
  UNKNOWN: 'Unresolved cohort',
}

/** Guidance on each accepted ASIA Impairment Scale grade. */
export const AIS_HELP: Record<string, string> = {
  A: 'ASIA Impairment Scale (AIS) grade A is operator-provided; Supraspina does not assign or validate it.',
  B: 'ASIA Impairment Scale (AIS) grade B is operator-provided; Supraspina does not assign or validate it.',
  C: 'ASIA Impairment Scale (AIS) grade C is operator-provided; Supraspina does not assign or validate it.',
  D: 'ASIA Impairment Scale (AIS) grade D is operator-provided; Supraspina does not assign or validate it.',
}

/** Guidance on each QC verdict or review state. */
export const QC_VERDICT_HELP: Record<string, string> = {
  pass: 'Pass means the reviewer accepts the subject, and it stays in the current analysis.',
  fail: 'Fail means the reviewer rejects the subject, and downstream cohort analysis excludes it.',
  review:
    'Defer means the subject needs another review before it gets a current-analysis verdict.',
  exclude: 'Exclude means the subject is deliberately left out of analysis.',
  unreviewed:
    'Unreviewed means no verdict is recorded yet for the current evidence.',
}

/** Guidance on dependency and workflow status values. */
export const STATUS_MEANING: Record<string, string> = {
  found: 'This dependency satisfies the configured diagnostic check.',
  missing:
    'This dependency is missing. Install it before running the steps that require it.',
  wrong:
    'This dependency is not the version the pipeline requires. Install the required version.',
  warn: 'This dependency may have a version or configuration problem. Inspect it.',
  skipped:
    'This dependency check does not apply to this operating system, so it was skipped.',
  na: 'This dependency does not apply on this system.',
  ok: 'This dependency satisfies the configured diagnostic check.',
}

/**
 * Guidance on known dependency checks by check ID. Fall back to the check label for
 * unknown IDs.
 */
export const ENV_CHECK_HELP: Record<string, string> = {
  fshome:
    'The FreeSurfer installation location in FREESURFER_HOME, which reconstruction needs.',
  reconall: 'The FreeSurfer recon-all program, which reconstructs each brain.',
  license:
    'The FreeSurfer license file, which FreeSurfer needs before it runs; Supraspina checks only that it is present.',
  subjdir:
    'FreeSurfer writes each subject reconstruction to this project-derived directory. Supraspina creates it automatically when reconstruction runs with the FreeSurfer backend.',
  fastsurferdir:
    'FastSurfer writes each subject reconstruction to this project-derived directory. Supraspina creates it automatically when reconstruction runs with the FastSurfer backend.',
  matlab:
    'Licensed MATLAB with the Image Processing Toolbox, for the source ENIGMA QC backend.',
  mcr: 'The free MATLAB Runtime (R2019b / v9.7), which runs ENIGMA QC without a paid MATLAB license.',
  rscript: 'Rscript for the ENIGMA outlier review step.',
  finalrscript: 'The Rscript executable configured for the R analysis step.',
  rpkgs:
    'writexl, showtext, and sysfonts, which enable optional workbook and font enhancements.',
  rmarkdown:
    'R Markdown, needed only when R analysis report rendering is enabled.',
  knitr: 'knitr, needed only when R analysis report rendering is enabled.',
  pandoc:
    'Pandoc, which converts the R analysis report when report rendering is enabled.',
  python: 'The Python interpreter the pipeline requires.',
  conda:
    'The reviewed micromamba 2.7.0 executable and its SHA-256, which create the exact locked PyBrainAge environment. mamba and conda are not supported substitutes.',
  modelfile:
    'The trained PyBrainAge model file, which brain-age prediction needs.',
  scalerfile: 'The PyBrainAge feature scaler that matches the model.',
  pybrainpython:
    'The exact digest-bound Python environment that PyBrainAge uses.',
  bcenv:
    'The locked pcntoolkit 0.35.0 runtime that BrainCharts normative modeling uses; Scientific resources sets it up.',
  bcmodel:
    'The BrainCharts lifespan model with its site and phenotype lists, downloaded from GitHub and checked against pinned SHA-256 values.',
}

/**
 * A map from each dependency check to the pipeline step that it unblocks. Use this map
 * to explain failed checks without guessing unknown relationships.
 */
export const CONSEQUENCE_BY_ID: Record<string, string> = {
  mcr: 'ENIGMA QC',
  matlab: 'ENIGMA QC',
  modelfile: 'PyBrainAge prediction',
  scalerfile: 'PyBrainAge prediction',
  pybrainpython: 'PyBrainAge prediction',
  python: 'PyBrainAge prediction',
  rpkgs: 'the R analysis',
  rscript: 'the ENIGMA outlier review',
  finalrscript: 'the R analysis',
  rmarkdown: 'the R analysis report',
  knitr: 'the R analysis report',
  pandoc: 'the R analysis report',
  reconall: 'FreeSurfer recon-all',
  fshome: 'FreeSurfer recon-all',
  license: 'FreeSurfer recon-all',
  bcenv: 'BrainCharts normative modeling',
  bcmodel: 'BrainCharts normative modeling',
}

/**
 * Return the short pipeline step that a check unblocks.
 *
 * @returns The unblocked step name, or undefined when unknown.
 */
export function neededForStep(check: EnvCheck): string | undefined {
  return CONSEQUENCE_BY_ID[check.id]
}

/**
 * State what a failing check holds up in one sentence. Name the step from a
 * known ID mapping, or else return a generic non-empty message.
 */
export function consequenceFor(check: EnvCheck): string {
  const hit = CONSEQUENCE_BY_ID[check.id]
  if (hit) return `Needed for ${hit}.`
  return 'Resolve this check before running the affected steps.'
}
